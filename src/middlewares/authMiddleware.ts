// ============================================================
//  src/middlewares/authMiddleware.ts
//  Middleware Autentikasi — memverifikasi JWT dari header
// ============================================================

import { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import { JwtPayload, UserRole } from '../types/index.js';
import { sendUnauthorized, sendForbidden } from '../utils/response.js';
import db from '../config/database';

const JWT_SECRET = process.env['JWT_SECRET'];
if (!JWT_SECRET) {
  throw new Error('❌ JWT_SECRET tidak ditemukan di environment variables!');
}

// Cache singkat (15 detik) status user agar polling dashboard tidak membanjiri koneksi TiDB Cloud
interface CachedAuthUser {
  token_version: number;
  is_active: number;
  expiresAt: number;
}
const AUTH_CACHE_TTL_MS = 15_000;
const userAuthCache = new Map<number, CachedAuthUser>();

export const invalidateUserAuthCache = (userId?: number): void => {
  if (typeof userId === 'number' && userId > 0) {
    userAuthCache.delete(userId);
  } else {
    userAuthCache.clear();
  }
};

const getAuthUserState = async (userId: number): Promise<CachedAuthUser | null> => {
  const now = Date.now();
  const cached = userAuthCache.get(userId);
  if (cached && cached.expiresAt > now) {
    return cached;
  }

  const [rows] = (await db.query(
    'SELECT token_version, is_active FROM users WHERE id = ? LIMIT 1',
    [userId]
  )) as [any[], unknown];
  const dbUser = rows?.[0];
  if (!dbUser) {
    userAuthCache.delete(userId);
    return null;
  }

  const entry: CachedAuthUser = {
    token_version: Number(dbUser.token_version ?? 0),
    is_active: Number(dbUser.is_active ?? 1),
    expiresAt: now + AUTH_CACHE_TTL_MS,
  };
  if (userAuthCache.size > 2000) {
    userAuthCache.clear();
  }
  userAuthCache.set(userId, entry);
  return entry;
};

/**
 * verifyToken
 * Mengekstrak Bearer token dari header Authorization,
 * memverifikasi signature, lalu menyimpan payload ke res.locals.
 */
export const verifyToken = async (
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> => {
  let token: string | undefined;
  const authHeader = req.headers['authorization'];

  if (authHeader && authHeader.startsWith('Bearer ')) {
    token = authHeader.split(' ')[1];
  } else if (req.headers.cookie) {
    const cookies = req.headers.cookie.split(';');
    for (const cookie of cookies) {
      const parts = cookie.trim().split('=');
      const name = parts[0];
      const val = parts.slice(1).join('=');
      if (name === 'token' || name === 'jwt' || name === 'accessToken') {
        token = decodeURIComponent(val);
        break;
      }
    }
  }

  if (!token) {
    sendUnauthorized(res, 'Token autentikasi tidak ditemukan atau format salah.');
    return;
  }

  try {
    const decoded = jwt.verify(token, JWT_SECRET) as JwtPayload;

    const dbUser = await getAuthUserState(decoded.userId);

    if (!dbUser) {
      sendUnauthorized(res, 'Pengguna tidak ditemukan. Silakan login ulang.');
      return;
    }
    if (dbUser.is_active === 0) {
      sendForbidden(res, 'Akun Anda sedang dinonaktifkan.');
      return;
    }
    if ((decoded.ver ?? 0) !== dbUser.token_version) {
      sendUnauthorized(res, 'Sesi Anda telah diakhiri dari perangkat lain. Silakan login ulang.');
      return;
    }

    // Simpan payload ke res.locals dengan type assertion yang aman
    res.locals['userId'] = decoded.userId;
    res.locals['email'] = decoded.email;
    res.locals['role'] = decoded.role;
    req.user = { id: decoded.userId, ...decoded };

    next();
  } catch (err) {
    if (err instanceof jwt.TokenExpiredError) {
      sendUnauthorized(res, 'Token sudah kedaluwarsa. Silakan login ulang.');
    } else if (err instanceof jwt.JsonWebTokenError) {
      sendUnauthorized(res, 'Token tidak valid.');
    } else {
      sendUnauthorized(res, 'Gagal memverifikasi token.');
    }
  }
};

/**
 * optionalVerifyToken
 * Mengekstrak identitas user bila header Authorization / cookie JWT valid,
 * namun tetap melanjutkan request (next) bila tidak ada token (untuk endpoint hybrid/publik).
 */
export const optionalVerifyToken = async (
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> => {
  let token: string | undefined;
  const authHeader = req.headers['authorization'];

  if (authHeader && authHeader.startsWith('Bearer ')) {
    token = authHeader.split(' ')[1];
  } else if (req.headers.cookie) {
    const cookies = req.headers.cookie.split(';');
    for (const cookie of cookies) {
      const parts = cookie.trim().split('=');
      const name = parts[0];
      const val = parts.slice(1).join('=');
      if (name === 'token' || name === 'jwt' || name === 'accessToken') {
        token = decodeURIComponent(val);
        break;
      }
    }
  }

  if (!token) {
    next();
    return;
  }

  try {
    const decoded = jwt.verify(token, JWT_SECRET) as JwtPayload;
    const dbUser = await getAuthUserState(decoded.userId);

    if (dbUser && dbUser.is_active !== 0 && (decoded.ver ?? 0) === dbUser.token_version) {
      res.locals['userId'] = decoded.userId;
      res.locals['email'] = decoded.email;
      res.locals['role'] = decoded.role;
      req.user = { id: decoded.userId, ...decoded };
    }
  } catch {
    // Abaikan token tidak valid pada mode opsional
  }

  next();
};

/**
 * requireRole
 * Middleware untuk membatasi akses berdasarkan peran (RBAC).
 * Harus digunakan SETELAH verifyToken.
 */
export const requireRole = (allowedRoles: UserRole[]) => {
  return (_req: Request, res: Response, next: NextFunction): void => {
    const role = res.locals['role'] as UserRole | undefined;

    if (!role) {
      sendUnauthorized(res, 'Data autentikasi tidak lengkap. Token tidak valid.');
      return;
    }

    if (!allowedRoles.includes(role)) {
      sendForbidden(
        res,
        `Akses ditolak. Hanya ${allowedRoles.join(', ')} yang diizinkan.`
      );
      return;
    }

    next();
  };
};

/**
 * isAdmin
 * Middleware khusus admin (shortcut untuk requireRole(['admin']))
 */
export const isAdmin = requireRole(['admin']);

/**
 * Helper untuk mengambil data auth dari res.locals secara type-safe
 */
export const getAuthLocals = (
  res: Response
): { userId: number; email: string; role: UserRole } => {
  return {
    userId: res.locals['userId'] as number,
    email: res.locals['email'] as string,
    role: res.locals['role'] as UserRole,
  };
};
