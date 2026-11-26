"use strict";
// ============================================================
//  src/routes/authRoutes.ts
//  Router Autentikasi & Akun Pengguna
// ============================================================
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = require("express");
const authController_js_1 = require("../controllers/authController.js");
const uploadMiddleware_js_1 = require("../middlewares/uploadMiddleware.js");
const authMiddleware_js_1 = require("../middlewares/authMiddleware.js");
const rateLimitMiddleware_js_1 = require("../middlewares/rateLimitMiddleware.js");
const validatorMiddleware_js_1 = require("../middlewares/validatorMiddleware.js");
const schemas_js_1 = require("../validators/schemas.js");
const router = (0, express_1.Router)();
// Registrasi & Login
router.get('/check-username', authController_js_1.checkUsername);
router.post('/check-username', authController_js_1.checkUsername);
router.post('/register-customer', rateLimitMiddleware_js_1.otpSendRateLimiter, authController_js_1.registerCustomer);
router.post('/verify-register-otp', rateLimitMiddleware_js_1.otpVerifyRateLimiter, authController_js_1.verifyRegisterOtp);
router.post('/resend-register-otp', rateLimitMiddleware_js_1.otpSendRateLimiter, authController_js_1.resendRegisterOtp);
router.post('/register-mitra', uploadMiddleware_js_1.uploadMitraDocs, (0, validatorMiddleware_js_1.validateZod)(schemas_js_1.registerMitraSchema), authController_js_1.registerMitra);
router.post('/login', rateLimitMiddleware_js_1.loginRateLimiter, (0, validatorMiddleware_js_1.validateZod)(schemas_js_1.loginSchema), authController_js_1.login);
router.post('/login-mitra', rateLimitMiddleware_js_1.loginRateLimiter, (0, validatorMiddleware_js_1.validateZod)(schemas_js_1.loginSchema), authController_js_1.loginMitra);
router.post('/verify-login-otp', rateLimitMiddleware_js_1.otpVerifyRateLimiter, (0, validatorMiddleware_js_1.validateZod)(schemas_js_1.verifyOtpSchema), authController_js_1.verifyLoginOtp);
router.post('/resend-login-otp', rateLimitMiddleware_js_1.otpSendRateLimiter, authController_js_1.resendLoginOtp);
router.post('/google-login', (0, validatorMiddleware_js_1.validateZod)(schemas_js_1.googleLoginSchema), authController_js_1.googleLogin);
router.post('/google-register', (0, validatorMiddleware_js_1.validateZod)(schemas_js_1.googleLoginSchema), (req, _res, next) => {
    req.body.is_register = true;
    next();
}, authController_js_1.googleLogin);
// Lupa Kata Sandi & OTP
router.post('/forgot-password', rateLimitMiddleware_js_1.otpSendRateLimiter, (0, validatorMiddleware_js_1.validateZod)(schemas_js_1.forgotPasswordSchema), authController_js_1.forgotPassword);
router.post('/verify-otp', rateLimitMiddleware_js_1.otpVerifyRateLimiter, (0, validatorMiddleware_js_1.validateZod)(schemas_js_1.verifyOtpSchema), authController_js_1.verifyOtp);
router.post('/reset-password', rateLimitMiddleware_js_1.otpVerifyRateLimiter, (0, validatorMiddleware_js_1.validateZod)(schemas_js_1.resetPasswordSchema), authController_js_1.resetPassword);
// Autentikasi 2 Langkah (2FA), Ubah Kata Sandi, & Sesi Perangkat
router.post('/2fa/request-otp', authMiddleware_js_1.verifyToken, rateLimitMiddleware_js_1.otpSendRateLimiter, (0, validatorMiddleware_js_1.validateZod)(schemas_js_1.requestTwoFactorOtpSchema), authController_js_1.requestTwoFactorOtp);
router.post('/2fa/verify-otp', authMiddleware_js_1.verifyToken, rateLimitMiddleware_js_1.otpVerifyRateLimiter, (0, validatorMiddleware_js_1.validateZod)(schemas_js_1.verifyTwoFactorOtpSchema), authController_js_1.verifyTwoFactorOtp);
router.put('/change-password', authMiddleware_js_1.verifyToken, (0, validatorMiddleware_js_1.validateZod)(schemas_js_1.changePasswordSchema), authController_js_1.changePassword);
router.get('/devices', authMiddleware_js_1.verifyToken, authController_js_1.getKnownDevices);
router.post('/logout-other-devices', authMiddleware_js_1.verifyToken, authController_js_1.logoutOtherDevices);
// Refresh Token (perpanjangan sesi mobile)
router.post('/refresh', authController_js_1.refreshToken);
// Profil Pengguna & Dokumen
router.get('/profile', authMiddleware_js_1.verifyToken, authController_js_1.getProfile);
router.put('/profile', authMiddleware_js_1.verifyToken, uploadMiddleware_js_1.uploadProfileImages, (0, validatorMiddleware_js_1.validateZod)(schemas_js_1.updateProfileSchema), authController_js_1.updateProfile);
router.post('/reupload-docs', authMiddleware_js_1.verifyToken, uploadMiddleware_js_1.uploadMitraDocs, authController_js_1.reuploadDocs);
// FCM Device Token
router.post('/fcm-token', authMiddleware_js_1.verifyToken, authController_js_1.saveFcmToken);
exports.default = router;
//# sourceMappingURL=authRoutes.js.map