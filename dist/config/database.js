"use strict";
// ============================================================
//  src/config/database.ts
//  Konfigurasi koneksi MySQL / TiDB Cloud dengan connection pool & Sequelize
//  Otomatis mendukung TLS/SSL untuk TiDB Cloud (port 4000 / DB_SSL=true)
// ============================================================
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.testConnection = exports.sequelize = exports.pool = void 0;
const promise_1 = __importDefault(require("mysql2/promise"));
const sequelize_1 = require("sequelize");
const fs_1 = __importDefault(require("fs"));
const path_1 = __importDefault(require("path"));
const dotenv_1 = __importDefault(require("dotenv"));
dotenv_1.default.config();
const dbHost = (process.env['DB_HOST'] ?? 'localhost').trim();
const dbPort = Number(process.env['DB_PORT'] ?? 3306);
const dbUser = (process.env['DB_USERNAME'] ?? 'root').trim();
const dbPassword = process.env['DB_PASSWORD'] ?? '';
const dbName = (process.env['DB_DATABASE'] ?? 'dinoyocraft_db').trim();
const connectTimeoutMs = Number(process.env['DB_CONNECT_TIMEOUT_MS'] ?? 20000);
const dbSslFlag = (process.env['DB_SSL'] ?? '').trim().toLowerCase();
const isTiDbTarget = dbPort === 4000 || dbHost.toLowerCase().includes('tidbcloud.com');
const useSsl = dbSslFlag === 'true' ||
    dbSslFlag === '1' ||
    (dbSslFlag !== 'false' && dbSslFlag !== '0' && isTiDbTarget);
const buildSslOptions = () => {
    if (!useSsl)
        return undefined;
    const rejectUnauthorized = (process.env['DB_SSL_REJECT_UNAUTHORIZED'] ?? 'true').trim().toLowerCase() !== 'false';
    const sslOpts = {
        minVersion: 'TLSv1.2',
        rejectUnauthorized,
    };
    const caEnv = (process.env['DB_SSL_CA'] ?? '').trim();
    if (caEnv) {
        if (caEnv.includes('-----BEGIN')) {
            sslOpts['ca'] = caEnv.replace(/\\n/g, '\n');
        }
        else {
            const resolvedCaPath = path_1.default.resolve(process.cwd(), caEnv);
            if (fs_1.default.existsSync(resolvedCaPath)) {
                sslOpts['ca'] = fs_1.default.readFileSync(resolvedCaPath, 'utf8');
            }
            else {
                console.warn(`⚠️ [DB SSL] File CA tidak ditemukan di ${resolvedCaPath}, menggunakan CA bawaan sistem.`);
            }
        }
    }
    return sslOpts;
};
const sslOptions = buildSslOptions();
exports.pool = promise_1.default.createPool({
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
exports.pool.on('connection', (conn) => {
    conn.query("SET time_zone = '+07:00'");
});
exports.sequelize = new sequelize_1.Sequelize(dbName, dbUser, dbPassword, {
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
const ensureDatabaseExists = async () => {
    const safeDbName = dbName.replace(/`/g, '');
    if (!safeDbName)
        return;
    const bootstrapConn = await promise_1.default.createConnection({
        host: dbHost,
        port: dbPort,
        user: dbUser,
        password: dbPassword,
        connectTimeout: connectTimeoutMs,
        ...(sslOptions ? { ssl: sslOptions } : {}),
    });
    try {
        await bootstrapConn.query(`CREATE DATABASE IF NOT EXISTS \`${safeDbName}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`);
        console.log(`✅ Database '${safeDbName}' dipastikan tersedia di ${dbHost}:${dbPort}.`);
    }
    finally {
        await bootstrapConn.end();
    }
};
const testConnection = async () => {
    try {
        let conn;
        try {
            conn = await exports.pool.getConnection();
        }
        catch (err) {
            // Auto-buat database jika belum dibuat di TiDB Cloud / MySQL baru (ER_BAD_DB_ERROR = 1049)
            if (err?.errno === 1049 || err?.code === 'ER_BAD_DB_ERROR') {
                console.log(`ℹ️ Database '${dbName}' belum ada, mencoba membuat otomatis...`);
                await ensureDatabaseExists();
                conn = await exports.pool.getConnection();
            }
            else {
                throw err;
            }
        }
        console.log(`✅ MySQL/TiDB connection established successfully (${dbHost}:${dbPort}/${dbName}${useSsl ? ', TLS/SSL aktif' : ''}).`);
        conn.release();
        await exports.sequelize.authenticate();
        console.log('✅ Sequelize connection established successfully.');
    }
    catch (error) {
        console.error('❌ MySQL/TiDB connection failed:', error);
        process.exit(1);
    }
};
exports.testConnection = testConnection;
// Unified database proxy satisfying both mysql2 pool and Sequelize ORM
const db = new Proxy(exports.sequelize, {
    get(target, prop, receiver) {
        if (prop === 'execute' || prop === 'getConnection' || prop === 'release' || prop === 'end') {
            const val = exports.pool[prop];
            return typeof val === 'function' ? val.bind(exports.pool) : val;
        }
        if (prop === 'query') {
            return function (...args) {
                if (args.length > 1 &&
                    args[1] &&
                    typeof args[1] === 'object' &&
                    !Array.isArray(args[1]) &&
                    ('type' in args[1] || 'model' in args[1] || 'raw' in args[1] || 'logging' in args[1] || 'instance' in args[1])) {
                    return exports.sequelize.query.apply(exports.sequelize, args);
                }
                return exports.pool.query.apply(exports.pool, args);
            };
        }
        if (prop in exports.pool && !(prop in target)) {
            const val = exports.pool[prop];
            return typeof val === 'function' ? val.bind(exports.pool) : val;
        }
        const val = Reflect.get(target, prop, receiver);
        return typeof val === 'function' ? val.bind(target) : val;
    }
});
exports.default = db;
//# sourceMappingURL=database.js.map