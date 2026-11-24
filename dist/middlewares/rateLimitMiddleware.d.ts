/**
 * Login (POST /api/auth/login & /api/auth/login-mitra).
 * Login berhasil (HTTP < 400) tidak dihitung — hanya percobaan gagal
 * (email/password salah) yang dihitung. 5 kali gagal / 5 menit → 429.
 */
export declare const loginRateLimiter: import("express-rate-limit").RateLimitRequestHandler;
/**
 * Kirim / kirim ulang kode OTP. Semua request dihitung (termasuk yang sukses)
 * agar spam pengiriman OTP dibatasi. 5 kali / 5 menit → 429.
 */
export declare const otpSendRateLimiter: import("express-rate-limit").RateLimitRequestHandler;
/**
 * Verifikasi kode OTP. Verifikasi berhasil tidak dihitung — hanya kode salah
 * (brute-force) yang dihitung. 5 kali salah / 5 menit → 429.
 */
export declare const otpVerifyRateLimiter: import("express-rate-limit").RateLimitRequestHandler;
export declare const apiLimiter: import("express-rate-limit").RateLimitRequestHandler;
//# sourceMappingURL=rateLimitMiddleware.d.ts.map