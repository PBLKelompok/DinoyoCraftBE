// ============================================================
//  src/config/database.ts
//  Konfigurasi koneksi MySQL / TiDB Cloud dengan connection pool & Sequelize
//  Otomatis mendukung TLS/SSL untuk TiDB Cloud (port 4000 / DB_SSL=true)
// ============================================================

import mysql from 'mysql2/promise';
import { Sequelize } from 'sequelize';
import fs from 'fs';
import path from 'path';
import dotenv from 'dotenv';

dotenv.config();

const dbHost = (process.env['DB_HOST'] ?? 'localhost').trim();
const dbPort = Number(process.env['DB_PORT'] ?? 3306);
const dbUser = (process.env['DB_USERNAME'] ?? 'root').trim();
const dbPassword = process.env['DB_PASSWORD'] ?? '';
const dbName = (process.env['DB_DATABASE'] ?? 'dinoyocraft_db').trim();
const connectTimeoutMs = Number(process.env['DB_CONNECT_TIMEOUT_MS'] ?? 20000);

const dbSslFlag = (process.env['DB_SSL'] ?? '').trim().toLowerCase();
const isTiDbTarget = dbPort === 4000 || dbHost.toLowerCase().includes('tidbcloud.com');
const useSsl =
  dbSslFlag === 'true' ||
  dbSslFlag === '1' ||
  (dbSslFlag !== 'false' && dbSslFlag !== '0' && isTiDbTarget);

const buildSslOptions = (): Record<string, any> | undefined => {
  if (!useSsl) return undefined;

  const rejectUnauthorized =
    (process.env['DB_SSL_REJECT_UNAUTHORIZED'] ?? 'true').trim().toLowerCase() !== 'false';
  const sslOpts: Record<string, any> = {
    minVersion: 'TLSv1.2',
    rejectUnauthorized,
  };

  const caEnv = (process.env['DB_SSL_CA'] ?? '').trim();
  if (caEnv) {
    if (caEnv.includes('-----BEGIN')) {
      sslOpts['ca'] = caEnv.replace(/\\n/g, '\n');
    } else {
      const resolvedCaPath = path.resolve(process.cwd(), caEnv);
      if (fs.existsSync(resolvedCaPath)) {
        sslOpts['ca'] = fs.readFileSync(resolvedCaPath, 'utf8');
      } else {
        console.warn(`⚠️ [DB SSL] File CA tidak ditemukan di ${resolvedCaPath}, menggunakan CA bawaan sistem.`);
      }
    }
  }

  return sslOpts;
};

const sslOptions = buildSslOptions();

export const pool = mysql.createPool({
  host: dbHost,
  port: dbPort,
  user: dbUser,
  password: dbPassword,
  database: dbName,
  multipleStatements: true,
  waitForConnections: true,
  connectionLimit: Number(process.env['DB_CONNECTION_LIMIT'] ?? 10),
  queueLimit: 0,
  connectTimeout: connectTimeoutMs,
  idleTimeout: 60000,
  enableKeepAlive: true,
  keepAliveInitialDelay: 10000,
  charset: 'utf8mb4',
  timezone: '+07:00',
  ...(sslOptions ? { ssl: sslOptions } : {}),
});

pool.on('connection', (conn) => {
  conn.query("SET time_zone = '+07:00'");
});

export const sequelize = new Sequelize(dbName, dbUser, dbPassword, {
  host: dbHost,
  port: dbPort,
  dialect: 'mysql',
  logging: false,
  timezone: '+07:00',
  pool: {
    max: 5,
    min: 0,
    idle: 10000,
    acquire: 30000,
  },
  dialectOptions: {
    connectTimeout: connectTimeoutMs,
    ...(sslOptions ? { ssl: sslOptions } : {}),
  },
});

const ensureDatabaseExists = async (): Promise<void> => {
  const safeDbName = dbName.replace(/`/g, '');
  if (!safeDbName) return;

  const bootstrapConn = await mysql.createConnection({
    host: dbHost,
    port: dbPort,
    user: dbUser,
    password: dbPassword,
    connectTimeout: connectTimeoutMs,
    ...(sslOptions ? { ssl: sslOptions } : {}),
  });
  try {
    await bootstrapConn.query(
      `CREATE DATABASE IF NOT EXISTS \`${safeDbName}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`
    );
    console.log(`✅ Database '${safeDbName}' dipastikan tersedia di ${dbHost}:${dbPort}.`);
  } finally {
    await bootstrapConn.end();
  }
};

export const testConnection = async (): Promise<void> => {
  try {
    let conn;
    try {
      conn = await pool.getConnection();
    } catch (err: any) {
      // Auto-buat database jika belum dibuat di TiDB Cloud / MySQL baru (ER_BAD_DB_ERROR = 1049)
      if (err?.errno === 1049 || err?.code === 'ER_BAD_DB_ERROR') {
        console.log(`ℹ️ Database '${dbName}' belum ada, mencoba membuat otomatis...`);
        await ensureDatabaseExists();
        conn = await pool.getConnection();
      } else {
        throw err;
      }
    }

    console.log(
      `✅ MySQL/TiDB connection established successfully (${dbHost}:${dbPort}/${dbName}${useSsl ? ', TLS/SSL aktif' : ''}).`
    );
    conn.release();
    await sequelize.authenticate();
    console.log('✅ Sequelize connection established successfully.');
  } catch (error) {
    console.error('❌ MySQL/TiDB connection failed:', error);
    process.exit(1);
  }
};

// Unified database proxy satisfying both mysql2 pool and Sequelize ORM
const db: any = new Proxy(sequelize, {
  get(target: any, prop: string | symbol, receiver: any) {
    if (prop === 'execute' || prop === 'getConnection' || prop === 'release' || prop === 'end') {
      const val = (pool as any)[prop];
      return typeof val === 'function' ? val.bind(pool) : val;
    }
    if (prop === 'query') {
      return function (...args: any[]) {
        if (
          args.length > 1 &&
          args[1] &&
          typeof args[1] === 'object' &&
          !Array.isArray(args[1]) &&
          ('type' in args[1] || 'model' in args[1] || 'raw' in args[1] || 'logging' in args[1] || 'instance' in args[1])
        ) {
          return (sequelize.query as any).apply(sequelize, args);
        }
        return (pool.query as any).apply(pool, args);
      };
    }
    if (prop in pool && !(prop in target)) {
      const val = (pool as any)[prop];
      return typeof val === 'function' ? val.bind(pool) : val;
    }
    const val = Reflect.get(target, prop, receiver);
    return typeof val === 'function' ? val.bind(target) : val;
  }
});

export default db as unknown as mysql.Pool & Sequelize;
