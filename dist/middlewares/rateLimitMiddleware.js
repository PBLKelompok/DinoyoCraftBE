"use strict";
// ============================================================
//  src/middlewares/rateLimitMiddleware.ts
//  Rate Limiter KHUSUS endpoint Login & OTP
//  (endpoint pengambilan data biasa TIDAK dibatasi)
// ============================================================
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.apiLimiter = exports.otpVerifyRateLimiter = exports.otpSendRateLimiter = exports.loginRateLimiter = void 0;
const express_rate_limit_1 = __importDefault(require("express-rate-limit"));
/**
 * Login (POST /api/auth/login & /api/auth/login-mitra).
 * Login berhasil (HTTP < 400) tidak dihitung — hanya percobaan gagal
 * (email/password salah) yang dihitung. 5 kali gagal / 5 menit → 429.
 */
exports.loginRateLimiter = (0, express_rate_limit_1.default)({
    windowMs: 5 * 60 * 1000,
    limit: 5,
    skipSuccessfulRequests: true,
    standardHeaders: 'draft-8',
    legacyHeaders: false,
    message: {
        success: false,
        message: 'Terlalu banyak percobaan login yang gagal (email atau password salah). Silakan tunggu 5 menit sebelum mencoba lagi.',
    },
});
/**
 * Kirim / kirim ulang kode OTP. Semua request dihitung (termasuk yang sukses)
 * agar spam pengiriman OTP dibatasi. 5 kali / 5 menit → 429.
 */
exports.otpSendRateLimiter = (0, express_rate_limit_1.default)({
    windowMs: 5 * 60 * 1000,
    limit: 5,
    skipSuccessfulRequests: false,
    standardHeaders: 'draft-8',
    legacyHeaders: false,
    message: {
        success: false,
        message: 'Terlalu sering meminta pengiriman kode OTP. Silakan tunggu 5 menit sebelum meminta kode OTP baru.',
    },
});
/**
 * Verifikasi kode OTP. Verifikasi berhasil tidak dihitung — hanya kode salah
 * (brute-force) yang dihitung. 5 kali salah / 5 menit → 429.
 */
exports.otpVerifyRateLimiter = (0, express_rate_limit_1.default)({
    windowMs: 5 * 60 * 1000,
    limit: 5,
    skipSuccessfulRequests: true,
    standardHeaders: 'draft-8',
    legacyHeaders: false,
    message: {
        success: false,
        message: 'Terlalu banyak percobaan kode OTP yang salah. Silakan tunggu 5 menit sebelum mencoba lagi.',
    },
});
// Alias kompatibilitas (tidak lagi dipasang global di /api)
exports.apiLimiter = exports.loginRateLimiter;
//# sourceMappingURL=rateLimitMiddleware.js.map