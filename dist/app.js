"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.otpVerifyRateLimiter = exports.otpSendRateLimiter = exports.loginRateLimiter = exports.apiLimiter = void 0;
require("dotenv/config");
// ============================================================
//  src/app.ts
//  Konfigurasi Express Application & Global Middleware
// ============================================================
const express_1 = __importDefault(require("express"));
const cors_1 = __importDefault(require("cors"));
const helmet_1 = __importDefault(require("helmet"));
const dotenv_1 = __importDefault(require("dotenv"));
const index_js_1 = __importDefault(require("./routes/index.js"));
const errorMiddleware_js_1 = require("./middlewares/errorMiddleware.js");
const auditMiddleware_js_1 = require("./middlewares/auditMiddleware.js");
const path_1 = __importDefault(require("path"));
const fs_1 = __importDefault(require("fs"));
// Load environment variables SEBELUM apapun
dotenv_1.default.config();
const app = (0, express_1.default)();
app.set('trust proxy', 1);
// -------------------------------------------------------
// 1. CORS — Konfigurasi origin ramah Mobile & Web
// Tambahkan ini agar aplikasi web (Chrome) diizinkan mengakses API
// -------------------------------------------------------
app.use((0, cors_1.default)({
    origin: true,
    credentials: true,
    exposedHeaders: ['X-Request-ID'],
}));
// 1b. Request ID / Correlation ID Middleware (§10.1)
app.use(auditMiddleware_js_1.requestIdMiddleware);
// 2. Keamanan — Helmet & Rate Limiter
const isProd = process.env['NODE_ENV'] === 'production';
app.use((0, helmet_1.default)({
    crossOriginResourcePolicy: { policy: 'cross-origin' },
    crossOriginEmbedderPolicy: false,
    hsts: isProd ? undefined : false,
    contentSecurityPolicy: isProd ? undefined : false,
}));
// Rate limiter TIDAK dipasang global di /api agar auto-fetch / polling data
// (dashboard, chat, pesanan, dll.) tidak pernah terkena HTTP 429.
// Limiter hanya dipasang pada endpoint Login & OTP di src/routes/authRoutes.ts.
var rateLimitMiddleware_js_1 = require("./middlewares/rateLimitMiddleware.js");
Object.defineProperty(exports, "apiLimiter", { enumerable: true, get: function () { return rateLimitMiddleware_js_1.apiLimiter; } });
Object.defineProperty(exports, "loginRateLimiter", { enumerable: true, get: function () { return rateLimitMiddleware_js_1.loginRateLimiter; } });
Object.defineProperty(exports, "otpSendRateLimiter", { enumerable: true, get: function () { return rateLimitMiddleware_js_1.otpSendRateLimiter; } });
Object.defineProperty(exports, "otpVerifyRateLimiter", { enumerable: true, get: function () { return rateLimitMiddleware_js_1.otpVerifyRateLimiter; } });
// -------------------------------------------------------
// 3. Body Parsing
// -------------------------------------------------------
app.use(express_1.default.json({ limit: '10mb' }));
app.use(express_1.default.urlencoded({ extended: true, limit: '10mb' }));
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
app.use(auditMiddleware_js_1.auditLogger);
// -------------------------------------------------------
// 6. Health Check — sebelum router utama
// -------------------------------------------------------
app.get(['/health', '/api/health'], (_req, res) => {
    res.status(200).json({
        success: true,
        message: 'DinoyoCraft API is running 🚀',
        timestamp: new Date().toISOString(),
        environment: process.env['NODE_ENV'] ?? 'development',
    });
});
// Kunci target folder baca agar PERSIS SAMA dengan Multer
const targetFolder = path_1.default.join(process.cwd(), 'uploads');
console.log('📂 Static Server membaca dari:', targetFolder);
app.use('/uploads', express_1.default.static(targetFolder));
app.use('/api/uploads', express_1.default.static(targetFolder));
app.use('/assets/stickers', express_1.default.static(path_1.default.join(targetFolder, 'stickers')));
app.use('/stickers', express_1.default.static(path_1.default.join(targetFolder, 'stickers')));
// Abaikan request favicon browser agar tidak tercatat sebagai 404 warning
app.get('/favicon.ico', (_req, res) => {
    res.status(204).end();
});
// Fallback gambar bila file lama di tabel seed sudah tidak ada di folder uploads
const PLACEHOLDER_PNG_BASE64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=';
app.use(['/uploads', '/api/uploads'], (req, res, next) => {
    if (req.method !== 'GET' && req.method !== 'HEAD') {
        next();
        return;
    }
    if (!/\.(png|jpe?g|webp|gif|svg)$/i.test(req.path)) {
        next();
        return;
    }
    const fallbackImg = path_1.default.join(targetFolder, 'stickers', 'sticker_clay_crafting.jpg');
    res.setHeader('Cache-Control', 'public, max-age=3600');
    if (fs_1.default.existsSync(fallbackImg)) {
        res.sendFile(fallbackImg);
        return;
    }
    res.type('image/png').status(200).send(Buffer.from(PLACEHOLDER_PNG_BASE64, 'base64'));
});
// -------------------------------------------------------
// 7. Router Utama
// -------------------------------------------------------
app.use('/api', index_js_1.default);
// -------------------------------------------------------
// 8. 404 Handler — route tidak ditemukan
// -------------------------------------------------------
app.use(errorMiddleware_js_1.notFound);
// -------------------------------------------------------
// 9. Global Error Handler — HARUS paling terakhir
// -------------------------------------------------------
app.use(errorMiddleware_js_1.globalErrorHandler);
exports.default = app;
//# sourceMappingURL=app.js.map