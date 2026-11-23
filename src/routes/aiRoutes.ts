// ============================================================
//  src/routes/aiRoutes.ts
//  Router Modular: AI Analisis — mitra & admin
// ============================================================

import { Router } from 'express';
import * as aiController from '../controllers/aiController.js';
import { verifyToken, optionalVerifyToken, requireRole } from '../middlewares/authMiddleware.js';
import { validateZod } from '../middlewares/validatorMiddleware.js';
import { aiAnalysisSchema, aiChatSchema } from '../validators/schemas.js';

const router = Router();

/**
 * @route   POST /api/ai/chat
 * @desc    ClayBot — Asisten Virtual Katalog & Bantuan Pelanggan DinoyoCraft
 * @access  Public / Optional Auth (pengunjung, mitra, admin)
 */
router.post('/chat', optionalVerifyToken, validateZod(aiChatSchema), aiController.chatWithClayBot);

// Semua route analisis bisnis di bawah memerlukan autentikasi
router.use(verifyToken);

/**
 * @route   POST /api/ai/analyze
 * @desc    Menjalankan analisis AI untuk konteks bisnis keramik
 * @access  Protected (mitra & admin)
 */
router.post(
  '/analyze',
  requireRole(['mitra', 'admin']),
  validateZod(aiAnalysisSchema),
  aiController.analyzeWithAI
);

/**
 * @route   GET /api/ai/history
 * @desc    Riwayat analisis AI milik pengguna yang sedang login
 * @access  Protected (semua role)
 */
router.get('/history', aiController.getAiHistory);

export default router;
