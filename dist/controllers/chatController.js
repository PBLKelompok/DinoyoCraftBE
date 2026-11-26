"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.deleteConversation = exports.getCsAgent = exports.updateHeartbeat = exports.markConversationAsRead = exports.getUnreadChatCount = exports.getChatContacts = exports.getChatHistory = exports.getMessages = exports.sendMessage = exports.touchUserActivity = void 0;
const database_js_1 = __importDefault(require("../config/database.js"));
const pusher_js_1 = __importStar(require("../utils/pusher.js"));
const encryption_js_1 = require("../utils/encryption.js");
const notificationService_js_1 = require("../services/notificationService.js");
const uploadMiddleware_js_1 = require("../middlewares/uploadMiddleware.js");
/**
 * Memperbarui timestamp aktivitas terakhir user di database (last_seen_at)
 */
const touchUserActivity = async (userId) => {
    if (!userId || isNaN(userId))
        return;
    try {
        await database_js_1.default.query('UPDATE users SET last_seen_at = NOW() WHERE id = ?', [userId]);
    }
    catch (err) {
        // Non-blocking log
    }
};
exports.touchUserActivity = touchUserActivity;
// Memory lock / cache untuk mencegah race condition double click atau simultaneous submit (< 3000ms)
const recentSubmissions = new Map();
const parseMessageMetadata = (raw) => {
    if (!raw)
        return null;
    if (typeof raw === 'object' && !Array.isArray(raw)) {
        return raw;
    }
    if (typeof raw === 'string' && raw.trim()) {
        try {
            const parsed = JSON.parse(raw);
            if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
                return parsed;
            }
        }
        catch {
            return null;
        }
    }
    return null;
};
const summarizeMetadataPreview = (metadata) => {
    if (!metadata)
        return '';
    const ctxType = String(metadata.context_type || '').toLowerCase();
    if (ctxType === 'product') {
        const pName = metadata.product_name || metadata.name || 'Produk';
        return `🛍️ [Produk] ${pName}`;
    }
    if (ctxType === 'order') {
        const code = metadata.order_code || metadata.mitra_order_code || `#DNC-${metadata.order_id || ''}`;
        const pName = metadata.product_name || 'Pesanan';
        return `📦 [${code}] ${pName}`;
    }
    return '';
};
/**
 * Mengirim pesan baru dan mentrigger event real-time ke Pusher
 * POST /api/chat/send/:targetUserId atau POST /api/chat/send
 */
const sendMessage = async (req, res) => {
    try {
        const senderId = req.user?.id || req.user?.userId || res.locals['userId'];
        const targetUserId = req.params['targetUserId'] ||
            req.body['targetUserId'] ||
            req.body['target_user_id'] ||
            req.body['receiver_id'];
        const rawMessage = req.body['message'];
        const parsedMetadata = parseMessageMetadata(req.body['metadata']);
        const metadataJsonStr = parsedMetadata ? JSON.stringify(parsedMetadata) : null;
        let messageText = typeof rawMessage === 'string' ? rawMessage.trim() : '';
        if (!senderId) {
            res.status(401).json({ success: false, message: 'Autentikasi gagal. User tidak ditemukan.' });
            return;
        }
        if (!targetUserId) {
            res.status(400).json({ success: false, message: 'targetUserId wajib diisi.' });
            return;
        }
        const numericSenderId = Number(senderId);
        const numericTargetId = Number(targetUserId);
        if (!Number.isFinite(numericSenderId) ||
            numericSenderId <= 0 ||
            !Number.isFinite(numericTargetId) ||
            numericTargetId <= 0) {
            res.status(400).json({ success: false, message: 'ID pengirim atau penerima tidak valid.' });
            return;
        }
        // Perbarui aktivitas pengirim
        await (0, exports.touchUserActivity)(numericSenderId);
        // Ekstrak file gambar dari multipart upload (req.file atau req.files) atau body image_url
        let imageUrl = null;
        const reqFiles = req.files;
        const reqFile = req.file;
        if (reqFile) {
            imageUrl = (0, uploadMiddleware_js_1.getUploadedFileUrl)(reqFile);
        }
        else if (Array.isArray(reqFiles) && reqFiles.length > 0) {
            const imgFile = reqFiles.find((f) => f.fieldname === 'image' ||
                f.fieldname === 'file' ||
                f.fieldname === 'attachment') || reqFiles[0];
            if (imgFile) {
                imageUrl = (0, uploadMiddleware_js_1.getUploadedFileUrl)(imgFile);
            }
        }
        else if (req.body['image_url'] &&
            typeof req.body['image_url'] === 'string' &&
            req.body['image_url'].trim()) {
            let rawImg = req.body['image_url'].trim();
            // Normalisasi jika path berupa stiker atau aset
            if (rawImg.includes('sticker')) {
                const parts = rawImg.split('/');
                const stickerFile = parts[parts.length - 1];
                imageUrl = `/uploads/stickers/${stickerFile}`;
            }
            else if (!rawImg.startsWith('/') && !rawImg.startsWith('http')) {
                imageUrl = `/${rawImg}`;
            }
            else {
                imageUrl = rawImg;
            }
        }
        if (!messageText && !imageUrl && !parsedMetadata) {
            res.status(400).json({ success: false, message: 'Pesan, lampiran produk/pesanan, atau gambar wajib dikirim.' });
            return;
        }
        // Memory lock untuk mencegah in-flight race condition atau double submit (< 3 detik untuk pesan identik)
        const dedupKey = `${numericSenderId}_${numericTargetId}_${messageText}_${imageUrl || ''}_${metadataJsonStr || ''}`;
        const nowMs = Date.now();
        const existing = recentSubmissions.get(dedupKey);
        if (existing && (nowMs - existing.time) < 3000) {
            console.log(`[Chat Backend] In-flight / double submit dicegah untuk sender ${numericSenderId}`);
            try {
                const data = existing.promise ? await existing.promise : existing.result;
                res.status(200).json({
                    success: true,
                    message: 'Pesan sudah terkirim.',
                    data,
                });
                return;
            }
            catch {
                // Fallback jika promise gagal
            }
        }
        let resolveSubmission = () => { };
        const submissionPromise = new Promise((resolve) => {
            resolveSubmission = resolve;
        });
        recentSubmissions.set(dedupKey, { time: nowMs, promise: submissionPromise });
        setTimeout(() => {
            recentSubmissions.delete(dedupKey);
        }, 5000);
        // Cegah double submit dari database dalam jeda waktu singkat (< 3 detik untuk pesan identik)
        const [recentMsgs] = await database_js_1.default.query(`SELECT id, sender_id, receiver_id, message, image_url, metadata, is_read, created_at 
       FROM messages 
       WHERE sender_id = ? AND receiver_id = ? 
       ORDER BY id DESC LIMIT 1`, [numericSenderId, numericTargetId]);
        if (recentMsgs && recentMsgs.length > 0) {
            const last = recentMsgs[0];
            const diffMs = Date.now() - new Date(last.created_at).getTime();
            const lastDecrypted = (0, encryption_js_1.decryptMessage)(last.message || '');
            const lastMetaObj = parseMessageMetadata(last.metadata);
            const lastMetaStr = lastMetaObj ? JSON.stringify(lastMetaObj) : null;
            const isSameMsg = lastDecrypted === messageText &&
                (last.image_url || null) === (imageUrl || null) &&
                lastMetaStr === metadataJsonStr;
            if (diffMs < 3000 && isSameMsg) {
                console.log(`[Chat Backend] Double submit dicegah untuk sender ${numericSenderId}`);
                const resultData = {
                    ...last,
                    message: messageText,
                    image_url: imageUrl,
                    metadata: parsedMetadata,
                };
                resolveSubmission(resultData);
                recentSubmissions.set(dedupKey, { time: nowMs, result: resultData });
                res.status(200).json({
                    success: true,
                    message: 'Pesan sudah terkirim.',
                    data: resultData,
                });
                return;
            }
        }
        // 1. Enkripsi pesan sebelum masuk ke database
        const encryptedText = (0, encryption_js_1.encryptMessage)(messageText);
        // Simpan ke database (MySQL) beserta metadata JSON (preview produk / pesanan)
        const [result] = await database_js_1.default.query('INSERT INTO messages (sender_id, receiver_id, message, image_url, metadata, is_read) VALUES (?, ?, ?, ?, ?, 0)', [numericSenderId, numericTargetId, encryptedText, imageUrl, metadataJsonStr]);
        const insertId = result.insertId;
        const [rows] = await database_js_1.default.query('SELECT id, sender_id, receiver_id, message, image_url, metadata, is_read, created_at FROM messages WHERE id = ?', [insertId]);
        const newMessage = rows[0] || {
            id: insertId,
            sender_id: numericSenderId,
            receiver_id: numericTargetId,
            message: encryptedText,
            image_url: imageUrl,
            metadata: metadataJsonStr,
            created_at: new Date(),
        };
        // 2. Trigger Pusher agar frontend langsung menerima pesan secara real-time
        const [senderRows] = await database_js_1.default.query(`SELECT u.name, u.role, mp.store_name,
              COALESCE(NULLIF(TRIM(mp.store_name), ''), u.name) AS display_name,
              CASE
                WHEN mp.id IS NOT NULL OR u.role = 'mitra' THEN
                  CASE
                    WHEN mp.avatar_url IS NOT NULL AND mp.avatar_url != '' AND mp.avatar_url NOT LIKE '%googleusercontent.com%' AND mp.avatar_url NOT LIKE '%google.com%' THEN mp.avatar_url
                    WHEN u.avatar_url IS NOT NULL AND u.avatar_url != '' AND u.avatar_url NOT LIKE '%googleusercontent.com%' AND u.avatar_url NOT LIKE '%google.com%' THEN u.avatar_url
                    ELSE NULL
                  END
                ELSE NULLIF(u.avatar_url, '')
              END AS sender_avatar
       FROM users u
       LEFT JOIN mitra_profiles mp ON mp.user_id = u.id
       WHERE u.id = ? LIMIT 1`, [numericSenderId]);
        const isAdminSender = senderRows?.[0]?.role === 'admin';
        const senderName = isAdminSender
            ? 'Customer Service'
            : senderRows?.[0]?.display_name || senderRows?.[0]?.name || 'Seseorang';
        const senderAvatar = isAdminSender ? null : (senderRows?.[0]?.sender_avatar || null);
        const channelName = `chat-${Math.min(numericSenderId, numericTargetId)}-${Math.max(numericSenderId, numericTargetId)}`;
        const userTargetChannel = `user-${numericTargetId}`;
        const userSenderChannel = `user-${numericSenderId}`;
        const isAiMsg = Boolean(parsedMetadata?.is_ai);
        const msgType = parsedMetadata?.context_type
            ? String(parsedMetadata.context_type)
            : isAiMsg
                ? 'ai_reply'
                : imageUrl && imageUrl.includes('sticker')
                    ? 'sticker'
                    : imageUrl
                        ? 'image'
                        : 'text';
        if ((0, pusher_js_1.isPusherAvailable)()) {
            console.log(`[Pusher Backend] Triggering event 'new-message' on channels:`, [
                channelName,
                userTargetChannel,
                userSenderChannel,
            ]);
            try {
                await pusher_js_1.default.trigger([channelName, userTargetChannel, userSenderChannel], 'new-message', {
                    id: Number(newMessage.id),
                    sender_id: numericSenderId,
                    receiver_id: numericTargetId,
                    sender_name: senderName,
                    sender_avatar: senderAvatar,
                    store_name: isAdminSender ? 'Customer Service' : senderRows?.[0]?.store_name || senderName,
                    is_cs: isAdminSender,
                    message: messageText, // Kirim teks asli ke Pusher
                    image_url: imageUrl,
                    metadata: parsedMetadata,
                    type: msgType,
                    created_at: newMessage.created_at,
                });
                if ((0, pusher_js_1.isPusherAvailable)()) {
                    console.log(`[Pusher Backend] Event 'new-message' berhasil dikirim ke Pusher`);
                }
            }
            catch (pusherError) {
                console.warn('⚠️ Pusher trigger warning:', pusherError?.message || pusherError);
            }
        }
        // Trigger FCM Push Notification ke penerima chat
        const pushBody = messageText ||
            summarizeMetadataPreview(parsedMetadata) ||
            '📷 [Foto]';
        try {
            (0, notificationService_js_1.sendPushNotificationToUser)(numericTargetId, `Pesan Baru dari ${senderName}`, pushBody, {
                type: 'chat',
                route: `/chat-room?store=${encodeURIComponent(senderName)}&userId=${numericSenderId}${isAdminSender ? '&isCs=1' : ''}`,
                sender_id: String(numericSenderId),
                store_name: senderName,
                image_url: imageUrl || '',
            }).catch((err) => console.warn('[FCM] Push notification error:', err));
        }
        catch (fcmErr) {
            console.warn('⚠️ Gagal trigger push notification chat:', fcmErr);
        }
        const responseData = {
            ...newMessage,
            message: messageText, // Kirim teks asli di response
            image_url: imageUrl,
            metadata: parsedMetadata,
            type: msgType,
        };
        resolveSubmission(responseData);
        recentSubmissions.set(dedupKey, { time: nowMs, result: responseData });
        res.status(201).json({
            success: true,
            message: 'Pesan terkirim!',
            data: responseData,
        });
    }
    catch (error) {
        res.locals['loggedError'] = error instanceof Error ? error : new Error(String(error));
        console.error('❌ Error saat sendMessage:', error);
        res.status(500).json({
            success: false,
            message: 'Gagal mengirim pesan.',
            error: error.message,
        });
    }
};
exports.sendMessage = sendMessage;
/**
 * Mengambil riwayat pesan antara pengguna yang sedang login dan target user
 * GET /api/chat/messages/:targetUserId
 */
const getMessages = async (req, res) => {
    try {
        const currentUserId = req.user?.id || req.user?.userId || res.locals['userId'];
        const { targetUserId } = req.params;
        if (!currentUserId) {
            res.status(401).json({ success: false, message: 'Autentikasi gagal.' });
            return;
        }
        const numericCurrentId = Number(currentUserId);
        const numericTargetId = Number(targetUserId);
        if (!Number.isFinite(numericCurrentId) ||
            numericCurrentId <= 0 ||
            !Number.isFinite(numericTargetId) ||
            numericTargetId <= 0) {
            res.status(400).json({ success: false, message: 'ID lawan bicara chat tidak valid.' });
            return;
        }
        // Perbarui aktivitas user aktif
        await (0, exports.touchUserActivity)(numericCurrentId);
        // Ambil info status lawan bicara (online bila aktif dalam 2 menit terakhir)
        const [targetRows] = await database_js_1.default.query(`SELECT u.id, u.name, u.role, u.last_seen_at,
              (u.last_seen_at IS NOT NULL AND u.last_seen_at >= NOW() - INTERVAL 2 MINUTE) AS is_online,
              mp.store_name,
              CASE
                WHEN mp.id IS NOT NULL OR u.role = 'mitra' THEN
                  CASE
                    WHEN mp.avatar_url IS NOT NULL AND mp.avatar_url != '' AND mp.avatar_url NOT LIKE '%googleusercontent.com%' AND mp.avatar_url NOT LIKE '%google.com%' THEN mp.avatar_url
                    WHEN u.avatar_url IS NOT NULL AND u.avatar_url != '' AND u.avatar_url NOT LIKE '%googleusercontent.com%' AND u.avatar_url NOT LIKE '%google.com%' THEN u.avatar_url
                    ELSE NULL
                  END
                ELSE NULLIF(u.avatar_url, '')
              END AS avatar_url
       FROM users u
       LEFT JOIN mitra_profiles mp ON mp.user_id = u.id
       WHERE u.id = ? LIMIT 1`, [numericTargetId]);
        const targetUser = targetRows?.[0] || null;
        const targetIsOnline = targetUser
            ? Boolean(targetUser.is_online ||
                (targetUser.last_seen_at && (Date.now() - new Date(targetUser.last_seen_at).getTime() <= 2 * 60 * 1000)))
            : false;
        const [messages] = await database_js_1.default.query(`SELECT id, sender_id, receiver_id, message, image_url, metadata, is_read, created_at
       FROM messages
       WHERE (sender_id = ? AND receiver_id = ?) OR (sender_id = ? AND receiver_id = ?)
       ORDER BY created_at ASC, id ASC`, [numericCurrentId, numericTargetId, numericTargetId, numericCurrentId]);
        // Dekripsi pesan & parse metadata sebelum dikirim ke frontend
        const decryptedMessages = messages.map((msg) => {
            let imgUrl = msg.image_url || null;
            if (imgUrl && typeof imgUrl === 'string' && imgUrl.startsWith('assets/stickers/')) {
                imgUrl = `/uploads/stickers/${imgUrl.replace('assets/stickers/', '')}`;
            }
            const parsedMeta = parseMessageMetadata(msg.metadata);
            const isAiMsg = Boolean(parsedMeta?.is_ai);
            const msgType = parsedMeta?.context_type
                ? String(parsedMeta.context_type)
                : isAiMsg
                    ? 'ai_reply'
                    : imgUrl && imgUrl.includes('sticker')
                        ? 'sticker'
                        : imgUrl
                            ? 'image'
                            : 'text';
            return {
                ...msg,
                message: (0, encryption_js_1.decryptMessage)(msg.message || ''),
                image_url: imgUrl,
                metadata: parsedMeta,
                is_ai: isAiMsg,
                sender_type: isAiMsg ? String(parsedMeta?.sender_type || 'store_bot') : undefined,
                type: msgType,
            };
        });
        // Tandai pesan dari targetUserId yang masuk ke currentUserId sebagai sudah dibaca
        await database_js_1.default.query('UPDATE messages SET is_read = 1 WHERE sender_id = ? AND receiver_id = ? AND is_read = 0', [numericTargetId, numericCurrentId]);
        res.status(200).json({
            success: true,
            current_user_id: numericCurrentId,
            target_user: targetUser ? {
                id: targetUser.id,
                name: targetUser.role === 'admin' ? 'Customer Service' : (targetUser.store_name || targetUser.name),
                role: targetUser.role,
                avatar_url: targetUser.role === 'admin' ? null : (targetUser.avatar_url || null),
                is_cs: targetUser.role === 'admin',
                is_online: targetIsOnline,
                last_seen_at: targetUser.last_seen_at || null,
            } : null,
            is_online: targetIsOnline,
            last_seen_at: targetUser?.last_seen_at || null,
            data: decryptedMessages,
        });
    }
    catch (error) {
        res.locals['loggedError'] = error instanceof Error ? error : new Error(String(error));
        console.error('❌ Error saat getMessages:', error);
        res.status(500).json({
            success: false,
            message: 'Gagal mengambil riwayat pesan.',
            error: error.message,
        });
    }
};
exports.getMessages = getMessages;
// Alias getChatHistory untuk kemudahan dan kompatibilitas
exports.getChatHistory = exports.getMessages;
/**
 * Mengambil daftar kontak percakapan yang tersedia untuk user yang sedang login
 * GET /api/chat/contacts
 */
const getChatContacts = async (req, res) => {
    try {
        const currentUserId = req.user?.id || req.user?.userId || res.locals['userId'];
        if (!currentUserId) {
            res.status(401).json({ success: false, message: 'Autentikasi gagal.' });
            return;
        }
        const numericCurrentId = Number(currentUserId);
        const callerRole = String(req.user?.role || res.locals['role'] || '');
        await (0, exports.touchUserActivity)(numericCurrentId);
        const roleFilterSql = callerRole === 'pengunjung'
            ? `AND (
             u.role = 'admin'
             OR (u.role = 'mitra' AND mp.is_verified = 1 AND mp.is_active = 1)
             OR EXISTS (
               SELECT 1 FROM messages mh
               WHERE (mh.sender_id = u.id AND mh.receiver_id = ?)
                  OR (mh.sender_id = ? AND mh.receiver_id = u.id)
             )
           )`
            : '';
        const queryParams = [
            numericCurrentId,
            numericCurrentId,
            numericCurrentId,
            numericCurrentId,
            numericCurrentId,
            numericCurrentId,
            numericCurrentId,
            numericCurrentId,
            numericCurrentId,
            numericCurrentId,
        ];
        if (callerRole === 'pengunjung') {
            queryParams.push(numericCurrentId, numericCurrentId);
        }
        const [contacts] = await database_js_1.default.query(`SELECT 
        u.id, 
        u.name, 
        u.email, 
        u.role, 
        u.last_seen_at,
        (u.last_seen_at IS NOT NULL AND u.last_seen_at >= NOW() - INTERVAL 2 MINUTE) AS is_online,
        CASE
          WHEN mp.id IS NOT NULL OR u.role = 'mitra' THEN
            CASE
              WHEN mp.avatar_url IS NOT NULL AND mp.avatar_url != '' AND mp.avatar_url NOT LIKE '%googleusercontent.com%' AND mp.avatar_url NOT LIKE '%google.com%' THEN mp.avatar_url
              WHEN u.avatar_url IS NOT NULL AND u.avatar_url != '' AND u.avatar_url NOT LIKE '%googleusercontent.com%' AND u.avatar_url NOT LIKE '%google.com%' THEN u.avatar_url
              ELSE NULL
            END
          ELSE u.avatar_url
        END AS avatar_url,
        mp.store_name,
        (
          SELECT m.message FROM messages m 
          WHERE (m.sender_id = u.id AND m.receiver_id = ?) 
             OR (m.sender_id = ? AND m.receiver_id = u.id)
          ORDER BY m.created_at DESC, m.id DESC LIMIT 1
        ) AS last_message,
        (
          SELECT m.image_url FROM messages m 
          WHERE (m.sender_id = u.id AND m.receiver_id = ?) 
             OR (m.sender_id = ? AND m.receiver_id = u.id)
          ORDER BY m.created_at DESC, m.id DESC LIMIT 1
        ) AS last_image_url,
        (
          SELECT m.metadata FROM messages m 
          WHERE (m.sender_id = u.id AND m.receiver_id = ?) 
             OR (m.sender_id = ? AND m.receiver_id = u.id)
          ORDER BY m.created_at DESC, m.id DESC LIMIT 1
        ) AS last_metadata,
        (
          SELECT m.created_at FROM messages m 
          WHERE (m.sender_id = u.id AND m.receiver_id = ?) 
             OR (m.sender_id = ? AND m.receiver_id = u.id)
          ORDER BY m.created_at DESC, m.id DESC LIMIT 1
        ) AS last_message_time,
        (
          SELECT COUNT(*) FROM messages m 
          WHERE m.sender_id = u.id AND m.receiver_id = ? AND m.is_read = 0
        ) AS unread_count
      FROM users u
      LEFT JOIN mitra_profiles mp ON u.id = mp.user_id
      WHERE u.id != ? AND u.is_active = 1 ${roleFilterSql}
      ORDER BY (last_message_time IS NOT NULL) DESC, last_message_time DESC, u.name ASC`, queryParams);
        // Dekripsi preview pesan terakhir untuk setiap kontak
        const decryptedContacts = contacts.map((contact) => {
            const isAdmin = contact.role === 'admin';
            const lastImg = contact.last_image_url || '';
            const lastMeta = parseMessageMetadata(contact.last_metadata);
            const lastIsSticker = Boolean(lastImg && (lastImg.includes('sticker') || lastImg.includes('/stickers/')));
            let preview = contact.last_message ? (0, encryption_js_1.decryptMessage)(contact.last_message) : '';
            if (!preview && lastMeta) {
                preview = summarizeMetadataPreview(lastMeta);
            }
            if (!preview && lastImg) {
                preview = lastIsSticker ? '🏷️ Stiker' : '📷 [Foto]';
            }
            const isOnline = Boolean(contact.is_online ||
                (contact.last_seen_at && (Date.now() - new Date(contact.last_seen_at).getTime() <= 2 * 60 * 1000)));
            return {
                ...contact,
                name: isAdmin ? 'Customer Service' : contact.name,
                store_name: isAdmin ? 'Customer Service' : contact.store_name,
                avatar_url: isAdmin ? null : contact.avatar_url,
                is_cs: isAdmin,
                is_online: isOnline,
                last_seen_at: contact.last_seen_at || null,
                last_message: preview || contact.last_message || null,
                last_image_url: contact.last_image_url || null,
                last_metadata: lastMeta,
                last_message_is_ai: Boolean(lastMeta?.is_ai),
            };
        });
        // Untuk pelanggan/mitra: hindari duplikasi baris "Customer Service" bila ada beberapa akun admin.
        // Pertahankan kontak admin yang sudah memiliki riwayat pesan; bila semuanya kosong, pilih admin id terkecil.
        let finalContacts = decryptedContacts;
        if (callerRole !== 'admin') {
            const adminContacts = decryptedContacts.filter((c) => c.is_cs);
            if (adminContacts.length > 1) {
                const adminsWithHistory = adminContacts.filter((c) => Boolean(c.last_message_time) || Boolean(c.last_message));
                const keepIds = new Set((adminsWithHistory.length > 0
                    ? adminsWithHistory
                    : [[...adminContacts].sort((a, b) => Number(a.id) - Number(b.id))[0]]).map((c) => Number(c.id)));
                finalContacts = decryptedContacts.filter((c) => !c.is_cs || keepIds.has(Number(c.id)));
            }
        }
        res.status(200).json({
            success: true,
            current_user_id: numericCurrentId,
            data: finalContacts
        });
    }
    catch (error) {
        res.locals['loggedError'] = error instanceof Error ? error : new Error(String(error));
        console.error('❌ Error saat getChatContacts:', error);
        res.status(500).json({
            success: false,
            message: 'Gagal mengambil daftar kontak chat.',
            error: error.message
        });
    }
};
exports.getChatContacts = getChatContacts;
/**
 * Mengambil total jumlah pesan belum dibaca untuk user yang sedang login.
 * GET /api/chat/unread-count
 */
const getUnreadChatCount = async (req, res) => {
    try {
        const currentUserId = req.user?.id || req.user?.userId || res.locals['userId'];
        if (!currentUserId) {
            res.status(401).json({ success: false, message: 'Autentikasi gagal.' });
            return;
        }
        const numericCurrentId = Number(currentUserId);
        const [rows] = await database_js_1.default.query('SELECT COUNT(*) AS unread_count FROM messages WHERE receiver_id = ? AND is_read = 0', [numericCurrentId]);
        const [senderRows] = await database_js_1.default.query(`SELECT m.sender_id,
              CASE WHEN u.role = 'admin' THEN 'Customer Service'
                   ELSE COALESCE(NULLIF(TRIM(mp.store_name), ''), u.name)
              END AS store_name,
              COUNT(*) AS unread_count
       FROM messages m
       JOIN users u ON u.id = m.sender_id
       LEFT JOIN mitra_profiles mp ON mp.user_id = u.id
       WHERE m.receiver_id = ? AND m.is_read = 0
       GROUP BY m.sender_id, u.role, mp.store_name, u.name`, [numericCurrentId]);
        res.status(200).json({
            success: true,
            data: {
                unread_count: Number(rows?.[0]?.unread_count || 0),
                unread_senders: senderRows || [],
            },
        });
    }
    catch (error) {
        res.locals['loggedError'] = error instanceof Error ? error : new Error(String(error));
        console.error('❌ Error saat getUnreadChatCount:', error);
        res.status(500).json({
            success: false,
            message: 'Gagal mengambil jumlah pesan belum dibaca.',
            error: error.message,
        });
    }
};
exports.getUnreadChatCount = getUnreadChatCount;
/**
 * Menandai pesan dari targetUserId kepada user login sebagai sudah dibaca.
 * PATCH /api/chat/messages/:targetUserId/read
 */
const markConversationAsRead = async (req, res) => {
    try {
        const currentUserId = req.user?.id || req.user?.userId || res.locals['userId'];
        const { targetUserId } = req.params;
        if (!currentUserId) {
            res.status(401).json({ success: false, message: 'Autentikasi gagal.' });
            return;
        }
        const numericCurrentId = Number(currentUserId);
        const numericTargetId = Number(targetUserId);
        if (!Number.isFinite(numericCurrentId) ||
            numericCurrentId <= 0 ||
            !Number.isFinite(numericTargetId) ||
            numericTargetId <= 0) {
            res.status(400).json({ success: false, message: 'ID target chat tidak valid.' });
            return;
        }
        await (0, exports.touchUserActivity)(numericCurrentId);
        const [result] = await database_js_1.default.query('UPDATE messages SET is_read = 1 WHERE sender_id = ? AND receiver_id = ? AND is_read = 0', [numericTargetId, numericCurrentId]);
        const [countRows] = await database_js_1.default.query('SELECT COUNT(*) AS unread_count FROM messages WHERE receiver_id = ? AND is_read = 0', [numericCurrentId]);
        res.status(200).json({
            success: true,
            data: {
                marked_count: Number(result?.affectedRows || 0),
                unread_count: Number(countRows?.[0]?.unread_count || 0),
            },
        });
    }
    catch (error) {
        res.locals['loggedError'] = error instanceof Error ? error : new Error(String(error));
        console.error('❌ Error saat markConversationAsRead:', error);
        res.status(500).json({
            success: false,
            message: 'Gagal menandai pesan sudah dibaca.',
            error: error.message,
        });
    }
};
exports.markConversationAsRead = markConversationAsRead;
/**
 * Menerima heartbeat dari klien untuk memperbarui last_seen_at secara periodik
 * POST /api/chat/heartbeat
 */
const updateHeartbeat = async (req, res) => {
    try {
        const currentUserId = req.user?.id || req.user?.userId || res.locals['userId'];
        if (!currentUserId) {
            res.status(401).json({ success: false, message: 'Autentikasi gagal.' });
            return;
        }
        const numericCurrentId = Number(currentUserId);
        await (0, exports.touchUserActivity)(numericCurrentId);
        res.status(200).json({
            success: true,
            message: 'Heartbeat tercatat.',
            is_online: true,
            last_seen_at: new Date().toISOString(),
        });
    }
    catch (error) {
        res.locals['loggedError'] = error instanceof Error ? error : new Error(String(error));
        res.status(500).json({
            success: false,
            message: 'Gagal memperbarui heartbeat.',
            error: error.message,
        });
    }
};
exports.updateHeartbeat = updateHeartbeat;
/**
 * Mengambil akun Admin Customer Service resmi untuk eskalasi Live Chat dari ClayBot / Pusat Bantuan
 * GET /api/chat/cs-agent
 */
const getCsAgent = async (_req, res) => {
    try {
        const [rows] = await database_js_1.default.query(`SELECT id, name, email, avatar_url, last_seen_at,
              (last_seen_at IS NOT NULL AND last_seen_at >= NOW() - INTERVAL 2 MINUTE) AS is_online
       FROM users
       WHERE role = 'admin' AND is_active = 1
       ORDER BY (last_seen_at IS NOT NULL) DESC, last_seen_at DESC, id ASC
       LIMIT 1`);
        if (!rows || rows.length === 0) {
            res.status(404).json({
                success: false,
                message: 'Agen Customer Service sedang tidak tersedia.',
            });
            return;
        }
        const agent = rows[0];
        res.status(200).json({
            success: true,
            data: {
                id: Number(agent.id),
                name: 'Customer Service',
                display_name: 'Customer Service',
                agent_name: 'Customer Service',
                avatar_url: null,
                is_cs: true,
                is_online: Boolean(agent.is_online),
                last_seen_at: agent.last_seen_at || null,
            },
        });
    }
    catch (error) {
        res.locals['loggedError'] = error instanceof Error ? error : new Error(String(error));
        res.status(500).json({
            success: false,
            message: 'Gagal mengambil informasi CS.',
            error: error.message,
        });
    }
};
exports.getCsAgent = getCsAgent;
/**
 * Menghapus riwayat percakapan antara user yang sedang login dengan targetUserId
 * DELETE /api/chat/messages/:targetUserId
 */
const deleteConversation = async (req, res) => {
    try {
        const currentUserId = req.user?.id || req.user?.userId || res.locals['userId'];
        const { targetUserId } = req.params;
        if (!currentUserId || !targetUserId) {
            res.status(400).json({ success: false, message: 'Parameter percakapan tidak lengkap.' });
            return;
        }
        const uid1 = Number(currentUserId);
        const uid2 = Number(targetUserId);
        if (!Number.isFinite(uid1) || uid1 <= 0 || !Number.isFinite(uid2) || uid2 <= 0) {
            res.status(400).json({ success: false, message: 'ID percakapan tidak valid.' });
            return;
        }
        const [result] = await database_js_1.default.query('DELETE FROM messages WHERE (sender_id = ? AND receiver_id = ?) OR (sender_id = ? AND receiver_id = ?)', [uid1, uid2, uid2, uid1]);
        res.status(200).json({
            success: true,
            message: 'Riwayat percakapan berhasil dihapus.',
            deleted_count: Number(result?.affectedRows || 0),
        });
    }
    catch (error) {
        res.locals['loggedError'] = error instanceof Error ? error : new Error(String(error));
        console.error('❌ Error saat deleteConversation:', error);
        res.status(500).json({
            success: false,
            message: 'Gagal menghapus riwayat percakapan.',
            error: error.message,
        });
    }
};
exports.deleteConversation = deleteConversation;
//# sourceMappingURL=chatController.js.map