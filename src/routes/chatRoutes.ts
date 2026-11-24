// ============================================================
//  src/routes/chatRoutes.ts
//  Router Live Chat Terenkripsi & Pusher Realtime
// ============================================================

import { Router } from 'express';
import {
  sendMessage,
  getMessages,
  getChatContacts,
  getCsAgent,
  getUnreadChatCount,
  markConversationAsRead,
  deleteConversation,
  updateHeartbeat,
} from '../controllers/chatController.js';
import { verifyToken } from '../middlewares/authMiddleware.js';
import { validateZod } from '../middlewares/validatorMiddleware.js';
import { sendMessageSchema } from '../validators/schemas.js';
import upload from '../middlewares/uploadMiddleware.js';

const router = Router();

router.use(verifyToken);

router.get('/contacts', getChatContacts);
router.get('/cs-agent', getCsAgent);
router.get('/unread-count', getUnreadChatCount);
router.post('/heartbeat', updateHeartbeat);
router.get('/messages/:targetUserId', getMessages);
router.delete('/messages/:targetUserId', deleteConversation);
router.patch('/messages/:targetUserId/read', markConversationAsRead);
router.post('/send/:targetUserId', upload.any(), validateZod(sendMessageSchema), sendMessage);
router.post('/send', upload.any(), validateZod(sendMessageSchema), sendMessage);

export default router;
