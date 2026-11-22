import 'dotenv/config';
// ============================================================
//  src/app.ts
//  Konfigurasi Express Application & Global Middleware
// ============================================================

import express, { Application, Request, Response } from 'express';
import cors from 'cors';
import helmet from 'helmet';
import dotenv from 'dotenv';
import router from './routes/index.js';
import { notFound, globalErrorHandler } from './middlewares/errorMiddleware.js';
import { auditLogger, requestIdMiddleware } from './middlewares/auditMiddleware.js';
import path from 'path';
import fs from 'fs';

// Load environment variables SEBELUM apapun
dotenv.config();

const app: Application = express();
app.set('trust proxy', 1);

// -------------------------------------------------------
// 1. CORS — Konfigurasi origin ramah Mobile & Web
// Tambahkan ini agar aplikasi web (Chrome) diizinkan mengakses API
// -------------------------------------------------------
app.use(
  cors({
    origin: true,
    credentials: true,
    exposedHeaders: ['X-Request-ID'],
  })
);

// 1b. Request ID / Correlation ID Middleware (§10.1)
app.use(requestIdMiddleware);

// 2. Keamanan — Helmet & Rate Limiter
const isProd = process.env['NODE_ENV'] === 'production';
app.use(
  helmet({
    crossOriginResourcePolicy: { policy: 'cross-origin' },
    crossOriginEmbedderPolicy: false,
    hsts: isProd ? undefined : false,
    contentSecurityPolicy: isProd ? undefined : false,
  })
);

// Rate limiter TIDAK dipasang global di /api agar auto-fetch / polling data
// (dashboard, chat, pesanan, dll.) tidak pernah terkena HTTP 429.
// Limiter hanya dipasang pada endpoint Login & OTP di src/routes/authRoutes.ts.
export {
  apiLimiter,
  loginRateLimiter,
  otpSendRateLimiter,
  otpVerifyRateLimiter,
} from './middlewares/rateLimitMiddleware.js';

// -------------------------------------------------------
// 3. Body Parsing
// -------------------------------------------------------
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

// -------------------------------------------------------
// 4. Keamanan — Header dasar
// -------------------------------------------------------
app.use((_req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('X-XSS-Protection', '1; mode=block');
  res.removeHeader('X-Powered-By');
  next();
});

// -------------------------------------------------------
// 5. Audit Logger (non-blocking)
// -------------------------------------------------------
app.use(auditLogger);

// -------------------------------------------------------
// 6. Health Check — sebelum router utama
// -------------------------------------------------------
app.get(['/health', '/api/health'], (_req: Request, res: Response) => {
  res.status(200).json({
    success: true,
    message: 'DinoyoCraft API is running 🚀',
    timestamp: new Date().toISOString(),
    environment: process.env['NODE_ENV'] ?? 'development',
  });
});

// Kunci target folder baca agar PERSIS SAMA dengan Multer
const targetFolder = path.join(process.cwd(), 'uploads');
console.log('📂 Static Server membaca dari:', targetFolder);
app.use('/uploads', express.static(targetFolder));
app.use('/api/uploads', express.static(targetFolder));
app.use('/assets/stickers', express.static(path.join(targetFolder, 'stickers')));
app.use('/stickers', express.static(path.join(targetFolder, 'stickers')));

// Abaikan request favicon browser agar tidak tercatat sebagai 404 warning
app.get('/favicon.ico', (_req: Request, res: Response) => {
  res.status(204).end();
});

// Fallback gambar bila file lama di tabel seed sudah tidak ada di folder uploads
const PLACEHOLDER_PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=';
app.use(['/uploads', '/api/uploads'], (req: Request, res: Response, next) => {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    next();
    return;
  }
  if (!/\.(png|jpe?g|webp|gif|svg)$/i.test(req.path)) {
    next();
    return;
  }
  const fallbackImg = path.join(targetFolder, 'stickers', 'sticker_clay_crafting.jpg');
  res.setHeader('Cache-Control', 'public, max-age=3600');
  if (fs.existsSync(fallbackImg)) {
    res.sendFile(fallbackImg);
    return;
  }
  res.type('image/png').status(200).send(Buffer.from(PLACEHOLDER_PNG_BASE64, 'base64'));
});

// -------------------------------------------------------
// 7. Router Utama
// -------------------------------------------------------
app.use('/api', router);

// -------------------------------------------------------
// 8. 404 Handler — route tidak ditemukan
// -------------------------------------------------------
app.use(notFound);

// -------------------------------------------------------
// 9. Global Error Handler — HARUS paling terakhir
// -------------------------------------------------------
app.use(globalErrorHandler);

export default app;
