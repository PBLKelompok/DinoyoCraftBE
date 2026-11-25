import { Request, Response, NextFunction } from 'express';
import { UserRole } from '../types/index.js';
export declare const invalidateUserAuthCache: (userId?: number) => void;
/**
 * verifyToken
 * Mengekstrak Bearer token dari header Authorization,
 * memverifikasi signature, lalu menyimpan payload ke res.locals.
 */
export declare const verifyToken: (req: Request, res: Response, next: NextFunction) => Promise<void>;
/**
 * optionalVerifyToken
 * Mengekstrak identitas user bila header Authorization / cookie JWT valid,
 * namun tetap melanjutkan request (next) bila tidak ada token (untuk endpoint hybrid/publik).
 */
export declare const optionalVerifyToken: (req: Request, res: Response, next: NextFunction) => Promise<void>;
/**
 * requireRole
 * Middleware untuk membatasi akses berdasarkan peran (RBAC).
 * Harus digunakan SETELAH verifyToken.
 */
export declare const requireRole: (allowedRoles: UserRole[]) => (_req: Request, res: Response, next: NextFunction) => void;
/**
 * isAdmin
 * Middleware khusus admin (shortcut untuk requireRole(['admin']))
 */
export declare const isAdmin: (_req: Request, res: Response, next: NextFunction) => void;
/**
 * Helper untuk mengambil data auth dari res.locals secara type-safe
 */
export declare const getAuthLocals: (res: Response) => {
    userId: number;
    email: string;
    role: UserRole;
};
//# sourceMappingURL=authMiddleware.d.ts.map