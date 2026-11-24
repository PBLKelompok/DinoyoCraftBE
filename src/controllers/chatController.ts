import { Request, Response } from 'express';
import pool from '../config/database.js';
import pusher, { isPusherAvailable } from '../utils/pusher.js';
import { encryptMessage, decryptMessage } from '../utils/encryption.js';
import { sendPushNotificationToUser } from '../services/notificationService.js';

/**
 * Memperbarui timestamp aktivitas terakhir user di database (last_seen_at)
 */
export const touchUserActivity = async (userId: number): Promise<void> => {
  if (!userId || isNaN(userId)) return;
  try {
    await pool.query('UPDATE users SET last_seen_at = NOW() WHERE id = ?', [userId]);
  } catch (err) {
    // Non-blocking log
  }
};

// Memory lock / cache untuk mencegah race condition double click atau simultaneous submit (< 3000ms)
const recentSubmissions = new Map<string, { time: number; promise?: Promise<any>; result?: any }>();

const parseMessageMetadata = (raw: unknown): Record<string, any> | null => {
  if (!raw) return null;
  if (typeof raw === 'object' && !Array.isArray(raw)) {
    return raw as Record<string, any>;
  }
  if (typeof raw === 'string' && raw.trim()) {
    try {
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        return parsed as Record<string, any>;
      }
    } catch {
      return null;
    }
  }
  return null;
};

const summarizeMetadataPreview = (metadata: Record<string, any> | null): string => {
  if (!metadata) return '';
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
export const sendMessage = async (req: Request, res: Response): Promise<void> => {
  try {
    const senderId = (req as any).user?.id || (req as any).user?.userId || res.locals['userId'];
    const targetUserId =
      req.params['targetUserId'] ||
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
    if (
      !Number.isFinite(numericSenderId) ||
      numericSenderId <= 0 ||
      !Number.isFinite(numericTargetId) ||
      numericTargetId <= 0
    ) {
      res.status(400).json({ success: false, message: 'ID pengirim atau penerima tidak valid.' });
      return;
    }

    // Perbarui aktivitas pengirim
    await touchUserActivity(numericSenderId);

    // Ekstrak file gambar dari multipart upload (req.file atau req.files) atau body image_url
    let imageUrl: string | null = null;
    const reqFiles = (req as any).files;
    const reqFile = (req as any).file;
    if (reqFile) {
      imageUrl = `/uploads/${reqFile.filename}`;
    } else if (Array.isArray(reqFiles) && reqFiles.length > 0) {
      const imgFile =
        reqFiles.find(
          (f: any) =>
            f.fieldname === 'image' ||
            f.fieldname === 'file' ||
            f.fieldname === 'attachment'
        ) || reqFiles[0];
      if (imgFile) {
        imageUrl = `/uploads/${imgFile.filename}`;
      }
    } else if (
      req.body['image_url'] &&
      typeof req.body['image_url'] === 'string' &&
      req.body['image_url'].trim()
    ) {
      let rawImg = req.body['image_url'].trim();
      // Normalisasi jika path berupa stiker atau aset
      if (rawImg.includes('sticker')) {
        const parts = rawImg.split('/');
        const stickerFile = parts[parts.length - 1];
        imageUrl = `/uploads/stickers/${stickerFile}`;
      } else if (!rawImg.startsWith('/') && !rawImg.startsWith('http')) {
        imageUrl = `/${rawImg}`;
      } else {
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
      } catch {
        // Fallback jika promise gagal
      }
    }

    let resolveSubmission: (val: any) => void = () => { };
    const submissionPromise = new Promise((resolve) => {
      resolveSubmission = resolve;
    });
    recentSubmissions.set(dedupKey, { time: nowMs, promise: submissionPromise });
    setTimeout(() => {
      recentSubmissions.delete(dedupKey);
    }, 5000);

    // Cegah double submit dari database dalam jeda waktu singkat (< 3 detik untuk pesan identik)
    const [recentMsgs]: any = await pool.query(
      `SELECT id, sender_id, receiver_id, message, image_url, metadata, is_read, created_at 
       FROM messages 
       WHERE sender_id = ? AND receiver_id = ? 
       ORDER BY id DESC LIMIT 1`,
      [numericSenderId, numericTargetId]
    );

    if (recentMsgs && recentMsgs.length > 0) {
      const last = recentMsgs[0];
      const diffMs = Date.now() - new Date(last.created_at).getTime();
      const lastDecrypted = decryptMessage(last.message || '');
      const lastMetaObj = parseMessageMetadata(last.metadata);
      const lastMetaStr = lastMetaObj ? JSON.stringify(lastMetaObj) : null;
      const isSameMsg =
        lastDecrypted === messageText &&
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
    const encryptedText = encryptMessage(messageText);

    // Simpan ke database (MySQL) beserta metadata JSON (preview produk / pesanan)
    const [result]: any = await pool.query(
      'INSERT INTO messages (sender_id, receiver_id, message, image_url, metadata, is_read) VALUES (?, ?, ?, ?, ?, 0)',
      [numericSenderId, numericTargetId, encryptedText, imageUrl, metadataJsonStr]
    );

    const insertId = result.insertId;
    const [rows]: any = await pool.query(
      'SELECT id, sender_id, receiver_id, message, image_url, metadata, is_read, created_at FROM messages WHERE id = ?',
      [insertId]
    );

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
    const [senderRows]: any = await pool.query(
      `SELECT u.name, u.role, mp.store_name, COALESCE(NULLIF(TRIM(mp.store_name), ''), u.name) AS display_name
       FROM users u
       LEFT JOIN mitra_profiles mp ON mp.user_id = u.id
       WHERE u.id = ? LIMIT 1`,
      [numericSenderId]
    );
    const isAdminSender = senderRows?.[0]?.role === 'admin';
    const senderName = isAdminSender
      ? 'Customer Service'
      : senderRows?.[0]?.display_name || senderRows?.[0]?.name || 'Seseorang';

    const channelName = `chat-${Math.min(numericSenderId, numericTargetId)}-${Math.max(numericSenderId, numericTargetId)}`;
    const userTargetChannel = `user-${numericTargetId}`;
    const userSenderChannel = `user-${numericSenderId}`;

    const msgType = parsedMetadata
      ? String(parsedMetadata.context_type || 'context')
      : imageUrl && imageUrl.includes('sticker')
        ? 'sticker'
        : imageUrl
          ? 'image'
          : 'text';

    if (isPusherAvailable()) {
      console.log(`[Pusher Backend] Triggering event 'new-message' on channels:`, [
        channelName,
        userTargetChannel,
        userSenderChannel,
      ]);

      try {
        await pusher.trigger([channelName, userTargetChannel, userSenderChannel], 'new-message', {
          id: Number(newMessage.id),
          sender_id: numericSenderId,
          receiver_id: numericTargetId,
          sender_name: senderName,
          store_name: isAdminSender ? 'Customer Service' : senderRows?.[0]?.store_name || senderName,
          is_cs: isAdminSender,
          message: messageText, // Kirim teks asli ke Pusher
          image_url: imageUrl,
          metadata: parsedMetadata,
          type: msgType,
          created_at: newMessage.created_at,
        });
        if (isPusherAvailable()) {
          console.log(`[Pusher Backend] Event 'new-message' berhasil dikirim ke Pusher`);
        }
      } catch (pusherError) {
        console.warn('⚠️ Pusher trigger warning:', (pusherError as any)?.message || pusherError);
      }
    }

    // Trigger FCM Push Notification ke penerima chat
    const pushBody =
      messageText ||
      summarizeMetadataPreview(parsedMetadata) ||
      '📷 [Foto]';
    try {
      sendPushNotificationToUser(
        numericTargetId,
        `Pesan Baru dari ${senderName}`,
        pushBody,
        {
          type: 'chat',
          route: `/chat-room?store=${encodeURIComponent(senderName)}&userId=${numericSenderId}${isAdminSender ? '&isCs=1' : ''}`,
          sender_id: String(numericSenderId),
          store_name: senderName,
          image_url: imageUrl || '',
        }
      ).catch((err) => console.warn('[FCM] Push notification error:', err));
    } catch (fcmErr) {
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
  } catch (error: any) {
    res.locals['loggedError'] = error instanceof Error ? error : new Error(String(error));
    console.error('❌ Error saat sendMessage:', error);
    res.status(500).json({
      success: false,
      message: 'Gagal mengirim pesan.',
      error: error.message,
    });
  }
};

/**
 * Mengambil riwayat pesan antara pengguna yang sedang login dan target user
 * GET /api/chat/messages/:targetUserId
 */
export const getMessages = async (req: Request, res: Response): Promise<void> => {
  try {
    const currentUserId = (req as any).user?.id || (req as any).user?.userId || res.locals['userId'];
    const { targetUserId } = req.params;

    if (!currentUserId) {
      res.status(401).json({ success: false, message: 'Autentikasi gagal.' });
      return;
    }

    const numericCurrentId = Number(currentUserId);
    const numericTargetId = Number(targetUserId);
    if (
      !Number.isFinite(numericCurrentId) ||
      numericCurrentId <= 0 ||
      !Number.isFinite(numericTargetId) ||
      numericTargetId <= 0
    ) {
      res.status(400).json({ success: false, message: 'ID lawan bicara chat tidak valid.' });
      return;
    }

    // Perbarui aktivitas user aktif
    await touchUserActivity(numericCurrentId);

    // Ambil info status lawan bicara (online bila aktif dalam 2 menit terakhir)
    const [targetRows]: any = await pool.query(
      `SELECT u.id, u.name, u.role, u.last_seen_at,
              (u.last_seen_at IS NOT NULL AND u.last_seen_at >= NOW() - INTERVAL 2 MINUTE) AS is_online,
              mp.store_name
       FROM users u
       LEFT JOIN mitra_profiles mp ON mp.user_id = u.id
       WHERE u.id = ? LIMIT 1`,
      [numericTargetId]
    );

    const targetUser = targetRows?.[0] || null;
    const targetIsOnline = targetUser
      ? Boolean(
        targetUser.is_online ||
        (targetUser.last_seen_at && (Date.now() - new Date(targetUser.last_seen_at).getTime() <= 2 * 60 * 1000))
      )
      : false;

    const [messages]: any = await pool.query(
      `SELECT id, sender_id, receiver_id, message, image_url, metadata, is_read, created_at
       FROM messages
       WHERE (sender_id = ? AND receiver_id = ?) OR (sender_id = ? AND receiver_id = ?)
       ORDER BY created_at ASC, id ASC`,
      [numericCurrentId, numericTargetId, numericTargetId, numericCurrentId]
    );

    // Dekripsi pesan & parse metadata sebelum dikirim ke frontend
    const decryptedMessages = messages.map((msg: any) => {
      let imgUrl = msg.image_url || null;
      if (imgUrl && typeof imgUrl === 'string' && imgUrl.startsWith('assets/stickers/')) {
        imgUrl = `/uploads/stickers/${imgUrl.replace('assets/stickers/', '')}`;
      }
      const parsedMeta = parseMessageMetadata(msg.metadata);
      const msgType = parsedMeta
        ? String(parsedMeta.context_type || 'context')
        : imgUrl && imgUrl.includes('sticker')
          ? 'sticker'
          : imgUrl
            ? 'image'
            : 'text';
      return {
        ...msg,
        message: decryptMessage(msg.message || ''),
        image_url: imgUrl,
        metadata: parsedMeta,
        type: msgType,
      };
    });

    // Tandai pesan dari targetUserId yang masuk ke currentUserId sebagai sudah dibaca
    await pool.query(
      'UPDATE messages SET is_read = 1 WHERE sender_id = ? AND receiver_id = ? AND is_read = 0',
      [numericTargetId, numericCurrentId]
    );

    res.status(200).json({
      success: true,
      current_user_id: numericCurrentId,
      target_user: targetUser ? {
        id: targetUser.id,
        name: targetUser.role === 'admin' ? 'Customer Service' : (targetUser.store_name || targetUser.name),
        role: targetUser.role,
        is_cs: targetUser.role === 'admin',
        is_online: targetIsOnline,
        last_seen_at: targetUser.last_seen_at || null,
      } : null,
      is_online: targetIsOnline,
      last_seen_at: targetUser?.last_seen_at || null,
      data: decryptedMessages,
    });
  } catch (error: any) {
    res.locals['loggedError'] = error instanceof Error ? error : new Error(String(error));
    console.error('❌ Error saat getMessages:', error);
    res.status(500).json({
      success: false,
      message: 'Gagal mengambil riwayat pesan.',
      error: error.message,
    });
  }
};

// Alias getChatHistory untuk kemudahan dan kompatibilitas
export const getChatHistory = getMessages;

/**
 * Mengambil daftar kontak percakapan yang tersedia untuk user yang sedang login
 * GET /api/chat/contacts
 */
export const getChatContacts = async (req: Request, res: Response): Promise<void> => {
  try {
    const currentUserId = (req as any).user?.id || (req as any).user?.userId || res.locals['userId'];

    if (!currentUserId) {
      res.status(401).json({ success: false, message: 'Autentikasi gagal.' });
      return;
    }

    const numericCurrentId = Number(currentUserId);
    const callerRole = String((req as any).user?.role || res.locals['role'] || '');
    await touchUserActivity(numericCurrentId);

    const roleFilterSql =
      callerRole === 'pengunjung'
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

    const queryParams: any[] = [
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

    const [contacts]: any = await pool.query(
      `SELECT 
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
      ORDER BY (last_message_time IS NOT NULL) DESC, last_message_time DESC, u.name ASC`,
      queryParams
    );

    // Dekripsi preview pesan terakhir untuk setiap kontak
    const decryptedContacts = contacts.map((contact: any) => {
      const isAdmin = contact.role === 'admin';
      const lastImg = contact.last_image_url || '';
      const lastMeta = parseMessageMetadata(contact.last_metadata);
      const lastIsSticker = Boolean(
        lastImg && (lastImg.includes('sticker') || lastImg.includes('/stickers/'))
      );
      let preview = contact.last_message ? decryptMessage(contact.last_message) : '';
      if (!preview && lastMeta) {
        preview = summarizeMetadataPreview(lastMeta);
      }
      if (!preview && lastImg) {
        preview = lastIsSticker ? '🏷️ Stiker' : '📷 [Foto]';
      }
      const isOnline = Boolean(
        contact.is_online ||
        (contact.last_seen_at && (Date.now() - new Date(contact.last_seen_at).getTime() <= 2 * 60 * 1000))
      );
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
      };
    });

    // Untuk pelanggan/mitra: hindari duplikasi baris "Customer Service" bila ada beberapa akun admin.
    // Pertahankan kontak admin yang sudah memiliki riwayat pesan; bila semuanya kosong, pilih admin id terkecil.
    let finalContacts = decryptedContacts;
    if (callerRole !== 'admin') {
      const adminContacts = decryptedContacts.filter((c: any) => c.is_cs);
      if (adminContacts.length > 1) {
        const adminsWithHistory = adminContacts.filter(
          (c: any) => Boolean(c.last_message_time) || Boolean(c.last_message)
        );
        const keepIds = new Set<number>(
          (adminsWithHistory.length > 0
            ? adminsWithHistory
            : [[...adminContacts].sort((a: any, b: any) => Number(a.id) - Number(b.id))[0]]
          ).map((c: any) => Number(c.id))
        );
        finalContacts = decryptedContacts.filter(
          (c: any) => !c.is_cs || keepIds.has(Number(c.id))
        );
      }
    }

    res.status(200).json({
      success: true,
      current_user_id: numericCurrentId,
      data: finalContacts
    });
  } catch (error: any) {
    res.locals['loggedError'] = error instanceof Error ? error : new Error(String(error));
    console.error('❌ Error saat getChatContacts:', error);
    res.status(500).json({
      success: false,
      message: 'Gagal mengambil daftar kontak chat.',
      error: error.message
    });
  }
};

/**
 * Mengambil total jumlah pesan belum dibaca untuk user yang sedang login.
 * GET /api/chat/unread-count
 */
export const getUnreadChatCount = async (req: Request, res: Response): Promise<void> => {
  try {
    const currentUserId = (req as any).user?.id || (req as any).user?.userId || res.locals['userId'];
    if (!currentUserId) {
      res.status(401).json({ success: false, message: 'Autentikasi gagal.' });
      return;
    }

    const numericCurrentId = Number(currentUserId);
    const [rows]: any = await pool.query(
      'SELECT COUNT(*) AS unread_count FROM messages WHERE receiver_id = ? AND is_read = 0',
      [numericCurrentId]
    );
    const [senderRows]: any = await pool.query(
      `SELECT m.sender_id,
              CASE WHEN u.role = 'admin' THEN 'Customer Service'
                   ELSE COALESCE(NULLIF(TRIM(mp.store_name), ''), u.name)
              END AS store_name,
              COUNT(*) AS unread_count
       FROM messages m
       JOIN users u ON u.id = m.sender_id
       LEFT JOIN mitra_profiles mp ON mp.user_id = u.id
       WHERE m.receiver_id = ? AND m.is_read = 0
       GROUP BY m.sender_id, u.role, mp.store_name, u.name`,
      [numericCurrentId]
    );

    res.status(200).json({
      success: true,
      data: {
        unread_count: Number(rows?.[0]?.unread_count || 0),
        unread_senders: senderRows || [],
      },
    });
  } catch (error: any) {
    res.locals['loggedError'] = error instanceof Error ? error : new Error(String(error));
    console.error('❌ Error saat getUnreadChatCount:', error);
    res.status(500).json({
      success: false,
      message: 'Gagal mengambil jumlah pesan belum dibaca.',
      error: error.message,
    });
  }
};

/**
 * Menandai pesan dari targetUserId kepada user login sebagai sudah dibaca.
 * PATCH /api/chat/messages/:targetUserId/read
 */
export const markConversationAsRead = async (req: Request, res: Response): Promise<void> => {
  try {
    const currentUserId = (req as any).user?.id || (req as any).user?.userId || res.locals['userId'];
    const { targetUserId } = req.params;
    if (!currentUserId) {
      res.status(401).json({ success: false, message: 'Autentikasi gagal.' });
      return;
    }

    const numericCurrentId = Number(currentUserId);
    const numericTargetId = Number(targetUserId);
    if (
      !Number.isFinite(numericCurrentId) ||
      numericCurrentId <= 0 ||
      !Number.isFinite(numericTargetId) ||
      numericTargetId <= 0
    ) {
      res.status(400).json({ success: false, message: 'ID target chat tidak valid.' });
      return;
    }

    await touchUserActivity(numericCurrentId);

    const [result]: any = await pool.query(
      'UPDATE messages SET is_read = 1 WHERE sender_id = ? AND receiver_id = ? AND is_read = 0',
      [numericTargetId, numericCurrentId]
    );
    const [countRows]: any = await pool.query(
      'SELECT COUNT(*) AS unread_count FROM messages WHERE receiver_id = ? AND is_read = 0',
      [numericCurrentId]
    );

    res.status(200).json({
      success: true,
      data: {
        marked_count: Number(result?.affectedRows || 0),
        unread_count: Number(countRows?.[0]?.unread_count || 0),
      },
    });
  } catch (error: any) {
    res.locals['loggedError'] = error instanceof Error ? error : new Error(String(error));
    console.error('❌ Error saat markConversationAsRead:', error);
    res.status(500).json({
      success: false,
      message: 'Gagal menandai pesan sudah dibaca.',
      error: error.message,
    });
  }
};

/**
 * Menerima heartbeat dari klien untuk memperbarui last_seen_at secara periodik
 * POST /api/chat/heartbeat
 */
export const updateHeartbeat = async (req: Request, res: Response): Promise<void> => {
  try {
    const currentUserId = (req as any).user?.id || (req as any).user?.userId || res.locals['userId'];
    if (!currentUserId) {
      res.status(401).json({ success: false, message: 'Autentikasi gagal.' });
      return;
    }
    const numericCurrentId = Number(currentUserId);
    await touchUserActivity(numericCurrentId);

    res.status(200).json({
      success: true,
      message: 'Heartbeat tercatat.',
      is_online: true,
      last_seen_at: new Date().toISOString(),
    });
  } catch (error: any) {
    res.locals['loggedError'] = error instanceof Error ? error : new Error(String(error));
    res.status(500).json({
      success: false,
      message: 'Gagal memperbarui heartbeat.',
      error: error.message,
    });
  }
};

/**
 * Mengambil akun Admin Customer Service resmi untuk eskalasi Live Chat dari ClayBot / Pusat Bantuan
 * GET /api/chat/cs-agent
 */
export const getCsAgent = async (_req: Request, res: Response): Promise<void> => {
  try {
    const [rows]: any = await pool.query(
      `SELECT id, name, email, avatar_url, last_seen_at,
              (last_seen_at IS NOT NULL AND last_seen_at >= NOW() - INTERVAL 2 MINUTE) AS is_online
       FROM users
       WHERE role = 'admin' AND is_active = 1
       ORDER BY (last_seen_at IS NOT NULL) DESC, last_seen_at DESC, id ASC
       LIMIT 1`
    );

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
  } catch (error: any) {
    res.locals['loggedError'] = error instanceof Error ? error : new Error(String(error));
    res.status(500).json({
      success: false,
      message: 'Gagal mengambil informasi CS.',
      error: error.message,
    });
  }
};

/**
 * Menghapus riwayat percakapan antara user yang sedang login dengan targetUserId
 * DELETE /api/chat/messages/:targetUserId
 */
export const deleteConversation = async (req: Request, res: Response): Promise<void> => {
  try {
    const currentUserId = (req as any).user?.id || (req as any).user?.userId || res.locals['userId'];
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

    const [result]: any = await pool.query(
      'DELETE FROM messages WHERE (sender_id = ? AND receiver_id = ?) OR (sender_id = ? AND receiver_id = ?)',
      [uid1, uid2, uid2, uid1]
    );

    res.status(200).json({
      success: true,
      message: 'Riwayat percakapan berhasil dihapus.',
      deleted_count: Number(result?.affectedRows || 0),
    });
  } catch (error: any) {
    res.locals['loggedError'] = error instanceof Error ? error : new Error(String(error));
    console.error('❌ Error saat deleteConversation:', error);
    res.status(500).json({
      success: false,
      message: 'Gagal menghapus riwayat percakapan.',
      error: error.message,
    });
  }
};
