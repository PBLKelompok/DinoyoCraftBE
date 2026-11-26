"use strict";
// ============================================================
//  src/controllers/moderationController.ts
//  Controller Moderasi & Keamanan (Admin Only)
// ============================================================
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.cancelMyAccountDeletion = exports.submitAccountDeletion = exports.getMyAccountDeletionStatus = exports.submitReport = exports.handleDeletionAction = exports.getDeletionRequests = exports.handleReportAction = exports.getReports = void 0;
const bcryptjs_1 = __importDefault(require("bcryptjs"));
const database_js_1 = __importDefault(require("../config/database.js"));
const authMiddleware_js_1 = require("../middlewares/authMiddleware.js");
const pusher_js_1 = require("../utils/pusher.js");
const notificationService_js_1 = require("../services/notificationService.js");
const emailService_js_1 = require("../utils/emailService.js");
let tablesInitialized = false;
let initTablesPromise = null;
/**
 * Memastikan tabel reports dan account_deletions tersedia di database (tanpa mock data)
 */
const ensureModerationTables = async () => {
    if (tablesInitialized)
        return;
    if (initTablesPromise)
        return initTablesPromise;
    initTablesPromise = (async () => {
        try {
            await database_js_1.default.query(`
        CREATE TABLE IF NOT EXISTS \`reports\` (
          \`id\` int UNSIGNED NOT NULL AUTO_INCREMENT,
          \`reporter_id\` int UNSIGNED DEFAULT NULL,
          \`reporter_name\` varchar(150) NOT NULL,
          \`type\` varchar(50) NOT NULL,
          \`target_id\` int UNSIGNED DEFAULT NULL,
          \`target_name\` varchar(255) NOT NULL,
          \`reason\` text NOT NULL,
          \`status\` varchar(50) NOT NULL DEFAULT 'pending',
          \`action_taken\` varchar(50) DEFAULT NULL,
          \`resolved_at\` datetime DEFAULT NULL,
          \`created_at\` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP,
          \`updated_at\` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
          PRIMARY KEY (\`id\`)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
      `);
            await database_js_1.default
                .query('ALTER TABLE `reports` ADD COLUMN `action_taken` varchar(50) DEFAULT NULL')
                .catch(() => { });
            await database_js_1.default.query(`
        CREATE TABLE IF NOT EXISTS \`account_deletions\` (
          \`id\` int UNSIGNED NOT NULL AUTO_INCREMENT,
          \`user_id\` int UNSIGNED DEFAULT NULL,
          \`name\` varchar(100) NOT NULL,
          \`email\` varchar(255) NOT NULL,
          \`reason\` text NOT NULL,
          \`status\` enum('pending','approved','rejected') NOT NULL DEFAULT 'pending',
          \`resolved_at\` datetime DEFAULT NULL,
          \`created_at\` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP,
          \`updated_at\` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
          PRIMARY KEY (\`id\`)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
      `);
            tablesInitialized = true;
        }
        catch (err) {
            console.warn('⚠️ [ensureModerationTables] Inisialisasi tabel:', err);
        }
        finally {
            initTablesPromise = null;
        }
    })();
    return initTablesPromise;
};
/**
 * Format tanggal ke format lokal yang ramah dibaca (contoh: 24 Okt 2023)
 */
const formatDate = (date) => {
    if (!date)
        return '-';
    try {
        const d = new Date(date);
        const months = ['Jan', 'Feb', 'Mar', 'Apr', 'Mei', 'Jun', 'Jul', 'Agu', 'Sep', 'Okt', 'Nov', 'Des'];
        return `${d.getDate()} ${months[d.getMonth()]} ${d.getFullYear()}`;
    }
    catch {
        return String(date);
    }
};
/**
 * [GET] /api/admin/moderation/reports
 * Mengambil daftar laporan pelanggaran dengan filter Tipe, Status, dan Pencarian
 */
const getReports = async (req, res) => {
    try {
        await ensureModerationTables();
        const { search, type, status, page = 1, limit = 10 } = req.query;
        const pageNum = Math.max(1, Number(page) || 1);
        const limitNum = Math.max(1, Number(limit) || 10);
        const offset = (pageNum - 1) * limitNum;
        const conditions = [];
        const params = [];
        // Filter Status (Pending, Selesai / Resolved)
        if (status && status !== 'Semua Status' && status !== 'semua') {
            const statusStr = String(status).toLowerCase();
            if (statusStr === 'pending') {
                conditions.push("(LOWER(status) = 'pending')");
            }
            else if (statusStr === 'selesai' || statusStr === 'resolved') {
                conditions.push("(LOWER(status) = 'resolved' OR LOWER(status) = 'selesai')");
            }
            else {
                conditions.push('LOWER(status) = ?');
                params.push(statusStr);
            }
        }
        // Filter Tipe (Toko, Ulasan, Produk)
        if (type && type !== 'Semua Tipe' && type !== 'semua') {
            conditions.push('LOWER(type) = ?');
            params.push(String(type).toLowerCase());
        }
        // Pencarian berdasarkan nama pelapor, target, atau alasan
        if (search && String(search).trim()) {
            const keyword = `%${String(search).trim()}%`;
            conditions.push('(reporter_name LIKE ? OR target_name LIKE ? OR reason LIKE ?)');
            params.push(keyword, keyword, keyword);
        }
        const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
        // Hitung total data
        const [countRows] = await database_js_1.default.query(`SELECT COUNT(*) as total FROM reports ${whereClause}`, params);
        const total = Number(countRows[0]?.total || 0);
        // Ambil data laporan terpaginasi
        const [reports] = await database_js_1.default.query(`SELECT id, reporter_id, reporter_name, type, target_id, target_name, reason, status, action_taken, resolved_at, created_at, updated_at
       FROM reports
       ${whereClause}
       ORDER BY created_at DESC
       LIMIT ? OFFSET ?`, [...params, limitNum, offset]);
        // Format agar cocok dengan antarmuka Next.js dan Flutter
        const formattedReports = reports.map((r) => {
            const normalizedType = (r.type || 'toko').toLowerCase();
            const isResolved = r.status === 'Selesai' || r.status === 'resolved';
            const inferredAction = r.action_taken
                ? String(r.action_taken).toLowerCase()
                : isResolved
                    ? normalizedType === 'ulasan'
                        ? 'hapus'
                        : 'suspend'
                    : null;
            return {
                id: String(r.id),
                type: normalizedType,
                target: r.target_name,
                target_id: r.target_id,
                reporter: r.reporter_name,
                reporter_name: r.reporter_name,
                reason: r.reason,
                status: isResolved ? 'resolved' : 'pending',
                action_taken: inferredAction,
                date: formatDate(r.created_at),
                created_at: r.created_at,
                resolved_at: r.resolved_at,
            };
        });
        res.status(200).json({
            success: true,
            data: formattedReports,
            total,
            currentPage: pageNum,
            totalPages: Math.ceil(total / limitNum) || 1
        });
    }
    catch (error) {
        console.error('❌ Error getReports:', error);
        res.status(500).json({ success: false, message: 'Gagal mengambil data laporan', error: error.message });
    }
};
exports.getReports = getReports;
/**
 * [PUT] /api/admin/moderation/reports/:id/action
 * Mengeksekusi tindakan moderasi terhadap laporan (suspend toko/produk, hapus ulasan, atau abaikan)
 */
const handleReportAction = async (req, res) => {
    try {
        await ensureModerationTables();
        const { id } = req.params;
        const { action, targetId, type } = req.body; // action: 'abaikan' | 'suspend' | 'hapus' | 'delete' | 'ignore'
        const [rows] = await database_js_1.default.query('SELECT * FROM reports WHERE id = ?', [id]);
        if (!rows || rows.length === 0) {
            res.status(404).json({ success: false, message: 'Laporan tidak ditemukan' });
            return;
        }
        const report = rows[0];
        const targetEntityId = targetId || report.target_id;
        const reportType = (type || report.type || '').toLowerCase();
        const actionType = (action || '').toLowerCase();
        // Eksekusi tindakan berdasarkan tombol yang ditekan admin
        if (actionType === 'suspend' && (reportType === 'toko' || reportType === 'store')) {
            if (targetEntityId) {
                await database_js_1.default.query('UPDATE mitra_profiles SET is_active = 0 WHERE id = ?', [targetEntityId]);
            }
        }
        else if ((actionType === 'hapus' || actionType === 'delete') && (reportType === 'ulasan' || reportType === 'review')) {
            if (targetEntityId) {
                try {
                    const [revRows] = await database_js_1.default.query('SELECT r.product_id, p.mitra_id FROM reviews r LEFT JOIN products p ON r.product_id = p.id WHERE r.id = ? LIMIT 1', [targetEntityId]);
                    const reviewedProductId = revRows?.[0]?.product_id;
                    const reviewedMitraId = revRows?.[0]?.mitra_id;
                    await database_js_1.default.query('DELETE FROM reviews WHERE id = ?', [targetEntityId]);
                    if (reviewedProductId) {
                        const [prodStats] = await database_js_1.default.query('SELECT COUNT(*) AS total, COALESCE(AVG(rating), 0) AS avg_rating FROM reviews WHERE product_id = ?', [reviewedProductId]);
                        await database_js_1.default.query('UPDATE products SET rating = ?, total_reviews = ? WHERE id = ?', [
                            Number(prodStats?.[0]?.total || 0) > 0 ? Number(prodStats[0].avg_rating).toFixed(2) : 0,
                            Number(prodStats?.[0]?.total || 0),
                            reviewedProductId,
                        ]);
                    }
                    if (reviewedMitraId) {
                        const [mitraStats] = await database_js_1.default.query(`SELECT COUNT(r.id) AS total, COALESCE(AVG(r.rating), 0) AS avg_rating
               FROM reviews r
               JOIN products p ON r.product_id = p.id
               WHERE p.mitra_id = ?`, [reviewedMitraId]);
                        await database_js_1.default.query('UPDATE mitra_profiles SET rating = ?, total_reviews = ? WHERE id = ?', [
                            Number(mitraStats?.[0]?.total || 0) > 0 ? Number(mitraStats[0].avg_rating).toFixed(2) : 0,
                            Number(mitraStats?.[0]?.total || 0),
                            reviewedMitraId,
                        ]);
                    }
                }
                catch {
                    // Abaikan jika tabel reviews belum terpasang
                }
            }
        }
        else if (['suspend', 'hapus', 'delete', 'takedown'].includes(actionType) &&
            (reportType === 'produk' || reportType === 'product')) {
            if (targetEntityId) {
                await database_js_1.default.query('UPDATE products SET is_deleted = 1 WHERE id = ?', [targetEntityId]);
            }
        }
        // Jika 'abaikan' / 'ignore', tidak ada entitas yang diubah, hanya status laporan yang diperbarui
        // Ubah status laporan menjadi selesai / resolved beserta tindakan yang diambil
        const normalizedAction = actionType === 'abaikan' || actionType === 'ignore'
            ? 'abaikan'
            : actionType === 'hapus' || actionType === 'delete' || actionType === 'takedown'
                ? 'hapus'
                : 'suspend';
        await database_js_1.default.query("UPDATE reports SET status = 'resolved', action_taken = ?, resolved_at = NOW() WHERE id = ?", [normalizedAction, id]);
        res.status(200).json({
            success: true,
            message: `Tindakan ${action} berhasil diterapkan.`
        });
    }
    catch (error) {
        console.error('❌ Error handleReportAction:', error);
        res.status(500).json({ success: false, message: 'Gagal memproses tindakan', error: error.message });
    }
};
exports.handleReportAction = handleReportAction;
/**
 * [GET] /api/admin/moderation/account-deletions
 * Mengambil daftar pengajuan penghapusan akun customer
 */
const getDeletionRequests = async (req, res) => {
    try {
        await ensureModerationTables();
        const { search, status, page = 1, limit = 10 } = req.query;
        const pageNum = Math.max(1, Number(page) || 1);
        const limitNum = Math.max(1, Number(limit) || 10);
        const offset = (pageNum - 1) * limitNum;
        const conditions = [];
        const params = [];
        // Filter Status (pending, approved, rejected)
        if (status && status !== 'Semua Status' && status !== 'semua') {
            conditions.push('LOWER(status) = ?');
            params.push(String(status).toLowerCase());
        }
        // Pencarian berdasarkan nama, email, atau alasan
        if (search && String(search).trim()) {
            const keyword = `%${String(search).trim()}%`;
            conditions.push('(name LIKE ? OR email LIKE ? OR reason LIKE ?)');
            params.push(keyword, keyword, keyword);
        }
        const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
        // Hitung total data
        const [countRows] = await database_js_1.default.query(`SELECT COUNT(*) as total FROM account_deletions ${whereClause}`, params);
        const total = Number(countRows[0]?.total || 0);
        // Ambil data pengajuan terpaginasi
        const [deletions] = await database_js_1.default.query(`SELECT id, user_id, name, email, reason, status, resolved_at, created_at
       FROM account_deletions
       ${whereClause}
       ORDER BY created_at DESC
       LIMIT ? OFFSET ?`, [...params, limitNum, offset]);
        const formattedDeletions = deletions.map((d) => ({
            id: String(d.id),
            user_id: d.user_id,
            name: d.name,
            email: d.email,
            reason: d.reason,
            status: d.status,
            date: formatDate(d.created_at),
            created_at: d.created_at,
            resolved_at: d.resolved_at
        }));
        res.status(200).json({
            success: true,
            data: formattedDeletions,
            total,
            currentPage: pageNum,
            totalPages: Math.ceil(total / limitNum) || 1
        });
    }
    catch (error) {
        console.error('❌ Error getDeletionRequests:', error);
        res.status(500).json({ success: false, message: 'Gagal mengambil data pengajuan hapus akun', error: error.message });
    }
};
exports.getDeletionRequests = getDeletionRequests;
/**
 * [PUT] /api/admin/moderation/account-deletions/:id/action
 * Setujui atau tolak pengajuan penghapusan akun
 */
const handleDeletionAction = async (req, res) => {
    try {
        await ensureModerationTables();
        const { id } = req.params;
        const { action } = req.body; // 'approved' | 'rejected'
        if (!action || !['approved', 'rejected'].includes(action)) {
            res.status(400).json({ success: false, message: "Action harus berupa 'approved' atau 'rejected'" });
            return;
        }
        const [rows] = await database_js_1.default.query('SELECT * FROM account_deletions WHERE id = ?', [id]);
        if (!rows || rows.length === 0) {
            res.status(404).json({ success: false, message: 'Pengajuan hapus akun tidak ditemukan' });
            return;
        }
        const delReq = rows[0];
        // Jika disetujui, kirim notifikasi & sinyal force-logout realtime, email konfirmasi, lalu nonaktifkan akun
        if (action === 'approved') {
            let targetUserId = delReq.user_id ? Number(delReq.user_id) : null;
            let targetEmail = delReq.email ? String(delReq.email).trim() : '';
            let targetName = delReq.name ? String(delReq.name).trim() : 'Pelanggan';
            if (!targetUserId && targetEmail) {
                const [uLookup] = await database_js_1.default.query('SELECT id, name, email FROM users WHERE LOWER(TRIM(email)) = LOWER(TRIM(?)) LIMIT 1', [targetEmail]);
                if (uLookup && uLookup.length > 0) {
                    targetUserId = Number(uLookup[0].id);
                    targetName = uLookup[0].name || targetName;
                    targetEmail = uLookup[0].email || targetEmail;
                }
            }
            else if (targetUserId) {
                const [uLookup] = await database_js_1.default.query('SELECT id, name, email FROM users WHERE id = ? LIMIT 1', [targetUserId]);
                if (uLookup && uLookup.length > 0) {
                    targetName = uLookup[0].name || targetName;
                    targetEmail = uLookup[0].email || targetEmail;
                }
            }
            const notifTitle = 'Penghapusan Akun Disetujui';
            const notifBody = 'Pengajuan penghapusan akun DinoyoCraft Anda telah disetujui oleh Admin. Akun Anda kini telah dinonaktifkan.';
            if (targetUserId && targetUserId > 0) {
                // 1. Kirim push notification FCM ke perangkat aktif sebelum token perangkat dihapus
                await (0, notificationService_js_1.sendPushNotificationToUser)(targetUserId, notifTitle, notifBody, {
                    type: 'account_deleted',
                    category: 'account',
                    force_logout: 'true',
                    route: '/login',
                }).catch(() => { });
                // 2. Pancarkan event Pusher realtime agar aplikasi mobile langsung auto-logout seketika
                await pusher_js_1.pusher
                    .trigger(`user-${targetUserId}`, 'account-deleted', {
                    user_id: targetUserId,
                    force_logout: true,
                    title: notifTitle,
                    message: notifBody,
                })
                    .catch(() => { });
                // 3. Nonaktifkan user & naikkan token_version agar seluruh JWT/refresh token langsung gugur
                await database_js_1.default.query('UPDATE users SET is_active = 0, token_version = token_version + 1 WHERE id = ?', [targetUserId]);
                await database_js_1.default
                    .query('DELETE FROM user_device_tokens WHERE user_id = ?', [targetUserId])
                    .catch(() => { });
                (0, authMiddleware_js_1.invalidateUserAuthCache)(targetUserId);
            }
            else if (targetEmail) {
                await database_js_1.default.query('UPDATE users SET is_active = 0, token_version = token_version + 1 WHERE LOWER(TRIM(email)) = LOWER(TRIM(?))', [targetEmail]);
                (0, authMiddleware_js_1.invalidateUserAuthCache)();
            }
            // 4. Kirim email pemberitahuan penghapusan akun disetujui
            if (targetEmail && (0, emailService_js_1.isEmailConfigured)()) {
                (0, emailService_js_1.sendAccountDeletionApprovedEmail)(targetEmail, targetName).catch((err) => {
                    console.warn('⚠️ [handleDeletionAction] Gagal mengirim email persetujuan hapus akun:', err?.message || err);
                });
            }
        }
        // Update status pengajuan
        await database_js_1.default.query('UPDATE account_deletions SET status = ?, resolved_at = NOW() WHERE id = ?', [action, id]);
        res.status(200).json({
            success: true,
            message: action === 'approved'
                ? 'Pengajuan penghapusan akun disetujui. Akun telah dinonaktifkan.'
                : 'Pengajuan penghapusan akun ditolak.'
        });
    }
    catch (error) {
        console.error('❌ Error handleDeletionAction:', error);
        res.status(500).json({ success: false, message: 'Gagal memproses pengajuan hapus akun', error: error.message });
    }
};
exports.handleDeletionAction = handleDeletionAction;
const submitReport = async (req, res) => {
    try {
        await ensureModerationTables();
        const userId = req.user?.id || req.user?.userId || res.locals['userId'];
        const { type, target_id, target_name, reason } = req.body;
        if (!type || !reason) {
            res.status(400).json({ success: false, message: 'Tipe dan alasan laporan wajib diisi' });
            return;
        }
        let reporterName = 'Pengguna';
        if (userId) {
            const [uRows] = await database_js_1.default.query('SELECT name FROM users WHERE id = ?', [userId]);
            if (uRows && uRows.length > 0)
                reporterName = uRows[0].name;
        }
        const numericTargetId = target_id !== undefined && target_id !== null && !isNaN(Number(target_id)) && Number(target_id) > 0
            ? Number(target_id)
            : null;
        const [result] = await database_js_1.default.query(`INSERT INTO reports (reporter_id, reporter_name, type, target_id, target_name, reason, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, 'pending', NOW(), NOW())`, [userId || null, reporterName, type, numericTargetId, target_name || '-', reason]);
        res.status(201).json({
            success: true,
            message: 'Laporan Anda telah diterima dan akan ditinjau oleh tim kami.',
            reportId: result.insertId
        });
    }
    catch (error) {
        console.error('Error submitReport:', error);
        res.status(500).json({ success: false, message: 'Gagal mengirim laporan', error: error.message });
    }
};
exports.submitReport = submitReport;
const getMyAccountDeletionStatus = async (req, res) => {
    try {
        await ensureModerationTables();
        const userId = req.user?.id || req.user?.userId || res.locals['userId'];
        if (!userId) {
            res.status(401).json({ success: false, message: 'Unauthorized' });
            return;
        }
        const [uRows] = await database_js_1.default.query('SELECT id, name, email, password_hash, google_id FROM users WHERE id = ? LIMIT 1', [userId]);
        if (!uRows || uRows.length === 0) {
            res.status(404).json({ success: false, message: 'Pengguna tidak ditemukan.' });
            return;
        }
        const user = uRows[0];
        const [activeOrders] = await database_js_1.default.query("SELECT COUNT(*) AS cnt FROM orders WHERE user_id = ? AND status IN ('pending', 'paid', 'packed', 'shipped')", [userId]);
        const [delRows] = await database_js_1.default.query('SELECT id, reason, status, created_at, resolved_at FROM account_deletions WHERE user_id = ? OR email = ? ORDER BY id DESC LIMIT 5', [userId, user.email]);
        const pendingRequest = (delRows || []).find((r) => r.status === 'pending') || null;
        const latestRequest = (delRows || [])[0] || null;
        res.status(200).json({
            success: true,
            data: {
                email: user.email,
                has_password: Boolean(user.password_hash),
                has_active_orders: Number(activeOrders?.[0]?.cnt ?? 0) > 0,
                active_orders_count: Number(activeOrders?.[0]?.cnt ?? 0),
                pending_request: pendingRequest,
                latest_request: latestRequest,
            },
        });
    }
    catch (error) {
        console.error('Error getMyAccountDeletionStatus:', error);
        res.status(500).json({ success: false, message: 'Gagal memuat status penghapusan akun.', error: error.message });
    }
};
exports.getMyAccountDeletionStatus = getMyAccountDeletionStatus;
const submitAccountDeletion = async (req, res) => {
    try {
        await ensureModerationTables();
        const userId = req.user?.id || req.user?.userId || res.locals['userId'];
        const { reason, password, confirm_email } = req.body;
        if (!userId) {
            res.status(401).json({ success: false, message: 'Silakan masuk terlebih dahulu.' });
            return;
        }
        if (!reason || !String(reason).trim()) {
            res.status(400).json({ success: false, message: 'Alasan penghapusan akun wajib dipilih.' });
            return;
        }
        const [uRows] = await database_js_1.default.query('SELECT id, name, email, password_hash FROM users WHERE id = ? LIMIT 1', [userId]);
        if (!uRows || uRows.length === 0) {
            res.status(404).json({ success: false, message: 'Akun tidak ditemukan.' });
            return;
        }
        const user = uRows[0];
        // 1. Cek apakah sudah ada pengajuan berstatus pending
        const [existingPending] = await database_js_1.default.query("SELECT id FROM account_deletions WHERE (user_id = ? OR email = ?) AND status = 'pending' LIMIT 1", [user.id, user.email]);
        if (existingPending && existingPending.length > 0) {
            res.status(409).json({
                success: false,
                message: 'Anda sudah memiliki pengajuan penghapusan akun yang sedang menunggu peninjauan Admin.',
            });
            return;
        }
        // 2. Cek apakah masih memiliki pesanan aktif yang belum selesai
        const [activeOrders] = await database_js_1.default.query("SELECT COUNT(*) AS cnt FROM orders WHERE user_id = ? AND status IN ('pending', 'paid', 'packed', 'shipped')", [user.id]);
        if (Number(activeOrders?.[0]?.cnt ?? 0) > 0) {
            res.status(400).json({
                success: false,
                message: 'Selesaikan atau batalkan pesanan aktif Anda terlebih dahulu sebelum mengajukan penghapusan akun.',
            });
            return;
        }
        // 3. Verifikasi keamanan identitas (password untuk akun reguler, konfirmasi email untuk akun Google OAuth)
        if (user.password_hash) {
            if (!password || !String(password).trim()) {
                res.status(400).json({
                    success: false,
                    message: 'Kata sandi wajib diisi untuk mengonfirmasi penghapusan akun.',
                });
                return;
            }
            const isPassValid = await bcryptjs_1.default.compare(String(password), user.password_hash);
            if (!isPassValid) {
                res.status(400).json({
                    success: false,
                    message: 'Kata sandi konfirmasi salah.',
                });
                return;
            }
        }
        else {
            const cleanConfirmEmail = String(confirm_email || '').trim().toLowerCase();
            if (!cleanConfirmEmail || cleanConfirmEmail !== String(user.email).trim().toLowerCase()) {
                res.status(400).json({
                    success: false,
                    message: 'Ketik alamat email akun Anda dengan benar untuk mengonfirmasi penghapusan akun.',
                });
                return;
            }
        }
        const [result] = await database_js_1.default.query(`INSERT INTO account_deletions (user_id, name, email, reason, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, 'pending', NOW(), NOW())`, [user.id, user.name || 'Pengguna', user.email, String(reason).trim()]);
        res.status(201).json({
            success: true,
            message: 'Pengajuan penghapusan akun berhasil dikirim dan sedang menunggu peninjauan Admin.',
            data: {
                id: result.insertId,
                status: 'pending',
                reason: String(reason).trim(),
                created_at: new Date().toISOString(),
            },
            requestId: result.insertId,
        });
    }
    catch (error) {
        console.error('Error submitAccountDeletion:', error);
        res.status(500).json({ success: false, message: 'Gagal mengajukan penghapusan akun', error: error.message });
    }
};
exports.submitAccountDeletion = submitAccountDeletion;
const cancelMyAccountDeletion = async (req, res) => {
    try {
        await ensureModerationTables();
        const userId = req.user?.id || req.user?.userId || res.locals['userId'];
        if (!userId) {
            res.status(401).json({ success: false, message: 'Unauthorized' });
            return;
        }
        const [uRows] = await database_js_1.default.query('SELECT email FROM users WHERE id = ? LIMIT 1', [userId]);
        const userEmail = uRows?.[0]?.email || '';
        const [result] = await database_js_1.default.query("DELETE FROM account_deletions WHERE (user_id = ? OR email = ?) AND status = 'pending'", [userId, userEmail]);
        if (!result?.affectedRows) {
            res.status(404).json({
                success: false,
                message: 'Tidak ada pengajuan penghapusan akun berstatus menunggu yang dapat dibatalkan.',
            });
            return;
        }
        res.status(200).json({
            success: true,
            message: 'Pengajuan penghapusan akun berhasil dibatalkan.',
        });
    }
    catch (error) {
        console.error('Error cancelMyAccountDeletion:', error);
        res.status(500).json({ success: false, message: 'Gagal membatalkan pengajuan penghapusan akun.', error: error.message });
    }
};
exports.cancelMyAccountDeletion = cancelMyAccountDeletion;
//# sourceMappingURL=moderationController.js.map