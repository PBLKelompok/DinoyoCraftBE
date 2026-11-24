import 'dotenv/config';
import { Application } from 'express';
declare const app: Application;
export { apiLimiter, loginRateLimiter, otpSendRateLimiter, otpVerifyRateLimiter, } from './middlewares/rateLimitMiddleware.js';
export default app;
//# sourceMappingURL=app.d.ts.map