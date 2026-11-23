// ============================================================
//  src/routes/authRoutes.ts
//  Router Autentikasi & Akun Pengguna
// ============================================================

import { Router } from 'express';
import {
  registerCustomer,
  verifyRegisterOtp,
  resendRegisterOtp,
  registerMitra,
  login,
  loginMitra,
  verifyLoginOtp,
  resendLoginOtp,
  requestTwoFactorOtp,
  verifyTwoFactorOtp,
  changePassword,
  logoutOtherDevices,
  googleLogin,
  getProfile,
  updateProfile,
  forgotPassword,
  verifyOtp,
  resetPassword,
  reuploadDocs,
  saveFcmToken,
  checkUsername,
  refreshToken,
} from '../controllers/authController.js';
import { uploadMitraDocs, uploadProfileImages } from '../middlewares/uploadMiddleware.js';
import { verifyToken } from '../middlewares/authMiddleware.js';
import {
  loginRateLimiter,
  otpSendRateLimiter,
  otpVerifyRateLimiter,
} from '../middlewares/rateLimitMiddleware.js';
import { validateZod } from '../middlewares/validatorMiddleware.js';
import {
  registerMitraSchema,
  loginSchema,
  googleLoginSchema,
  forgotPasswordSchema,
  verifyOtpSchema,
  resetPasswordSchema,
  updateProfileSchema,
  changePasswordSchema,
  requestTwoFactorOtpSchema,
  verifyTwoFactorOtpSchema,
} from '../validators/schemas.js';

const router = Router();

// Registrasi & Login
router.get('/check-username', checkUsername);
router.post('/check-username', checkUsername);
router.post('/register-customer', otpSendRateLimiter, registerCustomer);
router.post('/verify-register-otp', otpVerifyRateLimiter, verifyRegisterOtp);
router.post('/resend-register-otp', otpSendRateLimiter, resendRegisterOtp);
router.post('/register-mitra', uploadMitraDocs, validateZod(registerMitraSchema), registerMitra);
router.post('/login', loginRateLimiter, validateZod(loginSchema), login);
router.post('/login-mitra', loginRateLimiter, validateZod(loginSchema), loginMitra);
router.post('/verify-login-otp', otpVerifyRateLimiter, validateZod(verifyOtpSchema), verifyLoginOtp);
router.post('/resend-login-otp', otpSendRateLimiter, resendLoginOtp);
router.post('/google-login', validateZod(googleLoginSchema), googleLogin);
router.post('/google-register', validateZod(googleLoginSchema), (req, _res, next) => {
  req.body.is_register = true;
  next();
}, googleLogin);

// Lupa Kata Sandi & OTP
router.post('/forgot-password', otpSendRateLimiter, validateZod(forgotPasswordSchema), forgotPassword);
router.post('/verify-otp', otpVerifyRateLimiter, validateZod(verifyOtpSchema), verifyOtp);
router.post('/reset-password', otpVerifyRateLimiter, validateZod(resetPasswordSchema), resetPassword);

// Autentikasi 2 Langkah (2FA), Ubah Kata Sandi, & Sesi Perangkat
router.post('/2fa/request-otp', verifyToken, otpSendRateLimiter, validateZod(requestTwoFactorOtpSchema), requestTwoFactorOtp);
router.post('/2fa/verify-otp', verifyToken, otpVerifyRateLimiter, validateZod(verifyTwoFactorOtpSchema), verifyTwoFactorOtp);
router.put('/change-password', verifyToken, validateZod(changePasswordSchema), changePassword);
router.post('/logout-other-devices', verifyToken, logoutOtherDevices);

// Refresh Token (perpanjangan sesi mobile)
router.post('/refresh', refreshToken);

// Profil Pengguna & Dokumen
router.get('/profile', verifyToken, getProfile);
router.put('/profile', verifyToken, uploadProfileImages, validateZod(updateProfileSchema), updateProfile);
router.post('/reupload-docs', verifyToken, uploadMitraDocs, reuploadDocs);

// FCM Device Token
router.post('/fcm-token', verifyToken, saveFcmToken);

export default router;
