"use strict";
// ============================================================
//  src/controllers/systemLogController.ts
//  Controller Admin System Logging, Live Monitoring, Export & Mobile Ingest
// ============================================================
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.ingestClientLog = exports.authorizePusherChannel = exports.bulkPurgeSystemLogs = exports.purgeSystemLog = exports.restoreSystemLog = exports.bulkDeleteSystemLogs = exports.softDeleteSystemLog = exports.exportSystemLogsCsv = exports.acknowledgeSystemLog = exports.getRelatedSystemLogs = exports.getSystemLogDetail = exports.getSystemLogsSummary = exports.getSystemLogs = void 0;
const database_js_1 = __importDefault(require("../config/database.js"));
const loggingService_js_1 = require("../services/loggingService.js");
let schemaReady = false;
let lastAutoPurgeCheckMs = 0;
const ensureReady = async () => {
    if (!schemaReady) {
        await (0, loggingService_js_1.ensureSystemLogsSchema)();
        schemaReady = true;
        lastAutoPurgeCheckMs = Date.now();
        return;
    }
    const now = Date.now();
    if (now - lastAutoPurgeCheckMs >= 5 * 60 * 1000) {
        lastAutoPurgeCheckMs = now;
        await (0, loggingService_js_1.purgeExpiredSystemLogs)();
    }
};
/**
 * Membangun klausa WHERE SQL dari query filter yang konsisten untuk
 * tabel, kartu ringkasan, ekspor CSV, dan hapus massal (§8.3, §11).
 */
const buildLogFilterWhere = (query) => {
    const conditions = [];
    const params = [];
    // Soft delete filter: default hanya menampilkan log yang belum dihapus
    const onlyDeleted = query.onlyDeleted === 'true' || query.onlyDeleted === '1';
    const includeDeleted = query.includeDeleted === 'true' || query.includeDeleted === '1';
    if (onlyDeleted) {
        conditions.push('deleted_at IS NOT NULL');
    }
    else if (!includeDeleted) {
        conditions.push('deleted_at IS NULL');
    }
    // Rentang waktu (§8.3): live | 24h | 7d | 30d | custom
    const range = String(query.range || 'live').toLowerCase();
    let rangeLabel = 'live';
    if (range === '24h') {
        conditions.push('occurred_at >= DATE_SUB(NOW(), INTERVAL 24 HOUR)');
        rangeLabel = '24-jam';
    }
    else if (range === '7d') {
        conditions.push('occurred_at >= DATE_SUB(NOW(), INTERVAL 7 DAY)');
        rangeLabel = '7-hari';
    }
    else if (range === '30d' || range === '1m') {
        conditions.push('occurred_at >= DATE_SUB(NOW(), INTERVAL 30 DAY)');
        rangeLabel = '1-bulan';
    }
    else if (range === 'custom') {
        rangeLabel = 'kustom';
        if (query.from) {
            conditions.push('occurred_at >= ?');
            params.push(new Date(String(query.from)));
        }
        if (query.to) {
            conditions.push('occurred_at <= ?');
            params.push(new Date(String(query.to)));
        }
    }
    // Delta catch-up setelah reconnect (§8.4)
    if (query.since) {
        conditions.push('occurred_at > ?');
        params.push(new Date(String(query.since)));
    }
    // Filter Kategori (§6)
    if (query.category && query.category !== 'all' && query.category !== 'live') {
        const cats = String(query.category)
            .split(',')
            .map((c) => c.trim())
            .filter(Boolean);
        if (cats.length === 1) {
            conditions.push('category = ?');
            params.push(cats[0]);
        }
        else if (cats.length > 1) {
            conditions.push(`category IN (${cats.map(() => '?').join(',')})`);
            params.push(...cats);
        }
    }
    // Filter Severity multi-pilih (§7, §8.2)
    if (query.severity && query.severity !== 'all') {
        const sevs = String(query.severity)
            .split(',')
            .map((s) => s.trim().toLowerCase())
            .filter(Boolean);
        if (sevs.length === 1) {
            conditions.push('severity = ?');
            params.push(sevs[0]);
        }
        else if (sevs.length > 1) {
            conditions.push(`severity IN (${sevs.map(() => '?').join(',')})`);
            params.push(...sevs);
        }
    }
    // Filter Outcome (success | failure | pending | info)
    if (query.outcome && query.outcome !== 'all') {
        const outcomes = String(query.outcome)
            .split(',')
            .map((o) => o.trim().toLowerCase())
            .filter(Boolean);
        if (outcomes.length === 1) {
            conditions.push('outcome = ?');
            params.push(outcomes[0]);
        }
        else if (outcomes.length > 1) {
            conditions.push(`outcome IN (${outcomes.map(() => '?').join(',')})`);
            params.push(...outcomes);
        }
    }
    // Filter HTTP Status / Group (§7, §8.2)
    if (query.statusCode && query.statusCode !== 'all') {
        const st = String(query.statusCode).trim().toLowerCase();
        if (st === '2xx') {
            conditions.push('(status_code >= 200 AND status_code < 300)');
        }
        else if (st === '3xx') {
            conditions.push('(status_code >= 300 AND status_code < 400)');
        }
        else if (st === '4xx') {
            conditions.push('(status_code >= 400 AND status_code < 500)');
        }
        else if (st === '5xx') {
            conditions.push('(status_code >= 500 AND status_code < 600)');
        }
        else if (st === '0' || st === 'non-http') {
            conditions.push('(status_code IS NULL OR status_code = 0)');
        }
        else if (/^\d+$/.test(st)) {
            conditions.push('status_code = ?');
            params.push(Number(st));
        }
    }
    // Filter Source & Role
    if (query.source && query.source !== 'all') {
        conditions.push('source = ?');
        params.push(String(query.source).trim());
    }
    if (query.role && query.role !== 'all') {
        conditions.push('role = ?');
        params.push(String(query.role).trim());
    }
    // Filter ID Korelasi (§8.2, §11)
    if (query.requestId) {
        conditions.push('(request_id LIKE ? OR trace_id LIKE ?)');
        const q = `%${String(query.requestId).trim()}%`;
        params.push(q, q);
    }
    if (query.userId && /^\d+$/.test(String(query.userId).trim())) {
        conditions.push('user_id = ?');
        params.push(Number(query.userId));
    }
    if (query.orderId && /^\d+$/.test(String(query.orderId).trim().replace(/\D/g, ''))) {
        conditions.push('order_id = ?');
        params.push(Number(String(query.orderId).replace(/\D/g, '')));
    }
    if (query.transactionId) {
        const rawTx = String(query.transactionId).trim();
        if (/^\d+$/.test(rawTx)) {
            conditions.push('(transaction_id = ? OR reference_code LIKE ?)');
            params.push(Number(rawTx), `%${rawTx}%`);
        }
        else {
            conditions.push('reference_code LIKE ?');
            params.push(`%${rawTx}%`);
        }
    }
    // Pencarian Kata Kunci Teks (§8.2)
    if (query.query && String(query.query).trim()) {
        const kw = `%${String(query.query).trim()}%`;
        conditions.push('(message LIKE ? OR event_name LIKE ? OR route_template LIKE ? OR event_id LIKE ? OR request_id LIKE ? OR reference_code LIKE ? OR error_code LIKE ? OR error_message LIKE ?)');
        params.push(kw, kw, kw, kw, kw, kw, kw, kw);
    }
    // Cursor Pagination berbasis (occurred_at, id) (§9.2)
    if (query.cursor && String(query.cursor).includes('|')) {
        const [cursorTime, cursorId] = String(query.cursor).split('|');
        if (cursorTime && cursorId) {
            conditions.push('(occurred_at < ? OR (occurred_at = ? AND id < ?))');
            const dt = new Date(cursorTime);
            params.push(dt, dt, Number(cursorId));
        }
    }
    const whereSql = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
    return { whereSql, params, rangeLabel };
};
const formatLogRow = (row, includeSensitiveDetail = false) => {
    let parsedMeta = null;
    if (row.metadata_json) {
        try {
            parsedMeta =
                typeof row.metadata_json === 'string'
                    ? JSON.parse(row.metadata_json)
                    : row.metadata_json;
        }
        catch {
            parsedMeta = null;
        }
    }
    return {
        id: Number(row.id),
        eventId: row.event_id,
        occurredAt: row.occurred_at ? new Date(row.occurred_at).toISOString() : new Date().toISOString(),
        createdAt: row.created_at ? new Date(row.created_at).toISOString() : null,
        category: row.category,
        eventName: row.event_name,
        severity: row.severity,
        outcome: row.outcome,
        message: row.message,
        source: row.source,
        service: row.service,
        http: row.http_method || row.route_template || row.status_code !== null
            ? {
                method: row.http_method || '-',
                route: row.route_template || '-',
                statusCode: row.status_code !== null ? Number(row.status_code) : 0,
                durationMs: row.duration_ms !== null ? Number(row.duration_ms) : 0,
            }
            : null,
        correlation: {
            requestId: row.request_id || null,
            traceId: row.trace_id || null,
            userId: row.user_id !== null ? Number(row.user_id) : null,
            role: row.role || null,
            orderId: row.order_id !== null ? Number(row.order_id) : null,
            transactionId: row.transaction_id !== null ? Number(row.transaction_id) : null,
            referenceCode: row.reference_code || null,
        },
        client: {
            platform: row.platform || null,
            appVersion: row.app_version || null,
            ipMasked: row.ip_masked || null,
            userAgent: includeSensitiveDetail ? row.user_agent || null : undefined,
        },
        error: row.error_code || row.error_name || row.error_message || (includeSensitiveDetail && row.error_stack)
            ? {
                code: row.error_code || null,
                name: row.error_name || null,
                message: row.error_message || null,
                stack: includeSensitiveDetail ? row.error_stack || null : undefined,
            }
            : null,
        metadata: includeSensitiveDetail ? parsedMeta : undefined,
        acknowledgedAt: row.acknowledged_at ? new Date(row.acknowledged_at).toISOString() : null,
        acknowledgedBy: row.acknowledged_by || null,
        deletedAt: row.deleted_at ? new Date(row.deleted_at).toISOString() : null,
        deletedBy: row.deleted_by || null,
        deleteReason: row.delete_reason || null,
        retentionExpiresAt: row.retention_expires_at
            ? new Date(row.retention_expires_at).toISOString()
            : null,
    };
};
// ------------------------------------------------------------
//  1. GET /api/admin/logs — Daftar Log dengan Filter & Cursor (§11)
// ------------------------------------------------------------
const getSystemLogs = async (req, res) => {
    try {
        await ensureReady();
        const limit = Math.min(500, Math.max(1, Number(req.query.limit) || 200));
        const { whereSql, params } = buildLogFilterWhere(req.query);
        const [rows] = await database_js_1.default.query(`SELECT *
       FROM system_logs
       ${whereSql}
       ORDER BY occurred_at DESC, id DESC
       LIMIT ?`, [...params, limit]);
        const formatted = (rows || []).map((r) => formatLogRow(r, false));
        const lastRow = rows && rows.length === limit ? rows[rows.length - 1] : null;
        const nextCursor = lastRow
            ? `${new Date(lastRow.occurred_at).toISOString()}|${lastRow.id}`
            : null;
        res.status(200).json({
            success: true,
            data: {
                items: formatted,
                nextCursor,
                hasMore: Boolean(nextCursor),
                serverTime: new Date().toISOString(),
            },
        });
    }
    catch (err) {
        console.error('Error getSystemLogs:', err);
        res.status(500).json({
            success: false,
            message: 'Gagal memuat daftar system logs',
            error: err?.message,
        });
    }
};
exports.getSystemLogs = getSystemLogs;
// ------------------------------------------------------------
//  2. GET /api/admin/logs/summary — Ringkasan Kartu & Badge (§8.1, §8.2, §11)
// ------------------------------------------------------------
const getSystemLogsSummary = async (req, res) => {
    try {
        await ensureReady();
        const queryForSummary = { ...req.query };
        delete queryForSummary.cursor;
        delete queryForSummary.severity;
        const queryForCategories = { ...queryForSummary };
        delete queryForCategories.category;
        const { whereSql, params } = buildLogFilterWhere(queryForSummary);
        const { whereSql: catWhereSql, params: catParams } = buildLogFilterWhere(queryForCategories);
        const [sevRows] = await database_js_1.default.query(`SELECT severity, COUNT(*) AS total
       FROM system_logs
       ${whereSql}
       GROUP BY severity`, params);
        const [catRows] = await database_js_1.default.query(`SELECT category, COUNT(*) AS total
       FROM system_logs
       ${catWhereSql}
       GROUP BY category`, catParams);
        const [unackRows] = await database_js_1.default.query(`SELECT COUNT(*) AS total
       FROM system_logs
       WHERE deleted_at IS NULL
         AND acknowledged_at IS NULL
         AND severity IN ('critical', 'error')
         AND occurred_at >= DATE_SUB(NOW(), INTERVAL 15 MINUTE)`);
        const [deletedCountRows] = await database_js_1.default.query(`SELECT COUNT(*) AS total
       FROM system_logs
       WHERE deleted_at IS NOT NULL`);
        const counts = {
            critical: 0,
            error: 0,
            warning: 0,
            success: 0,
            info: 0,
            debug: 0,
        };
        let totalEvents = 0;
        for (const r of sevRows || []) {
            const key = String(r.severity || '').toLowerCase();
            const val = Number(r.total || 0);
            if (key in counts)
                counts[key] = val;
            totalEvents += val;
        }
        const categoryCounts = {};
        for (const r of catRows || []) {
            categoryCounts[String(r.category)] = Number(r.total || 0);
        }
        const errorEvents = counts.critical + counts.error;
        const apiErrorRate = totalEvents > 0 ? Number(((errorEvents / totalEvents) * 100).toFixed(2)) : 0;
        res.status(200).json({
            success: true,
            data: {
                counts,
                totalEvents,
                apiErrorRate,
                unacknowledgedErrors15m: Number(unackRows?.[0]?.total || 0),
                deletedCount: Number(deletedCountRows?.[0]?.total || 0),
                trashRetentionDays: loggingService_js_1.TRASH_RETENTION_DAYS,
                categoryCounts,
                updatedAt: new Date().toISOString(),
            },
        });
    }
    catch (err) {
        console.error('Error getSystemLogsSummary:', err);
        res.status(500).json({
            success: false,
            message: 'Gagal memuat ringkasan system logs',
        });
    }
};
exports.getSystemLogsSummary = getSystemLogsSummary;
// ------------------------------------------------------------
//  3. GET /api/admin/logs/:eventId — Detail Satu Log (§8.2, §11)
// ------------------------------------------------------------
const getSystemLogDetail = async (req, res) => {
    try {
        await ensureReady();
        const { eventId } = req.params;
        const [rows] = await database_js_1.default.query('SELECT * FROM system_logs WHERE event_id = ? LIMIT 1', [eventId]);
        if (!rows || rows.length === 0) {
            res.status(404).json({ success: false, message: 'Data log tidak ditemukan' });
            return;
        }
        const detail = formatLogRow(rows[0], true);
        res.status(200).json({
            success: true,
            data: detail,
        });
    }
    catch (err) {
        console.error('Error getSystemLogDetail:', err);
        res.status(500).json({ success: false, message: 'Gagal memuat detail log' });
    }
};
exports.getSystemLogDetail = getSystemLogDetail;
// ------------------------------------------------------------
//  4. GET /api/admin/logs/:eventId/related — Chain Korelasi (§8.2, §11)
// ------------------------------------------------------------
const getRelatedSystemLogs = async (req, res) => {
    try {
        await ensureReady();
        const { eventId } = req.params;
        const [rows] = await database_js_1.default.query('SELECT * FROM system_logs WHERE event_id = ? LIMIT 1', [eventId]);
        if (!rows || rows.length === 0) {
            res.status(404).json({ success: false, message: 'Event log tidak ditemukan' });
            return;
        }
        const target = rows[0];
        const orClauses = [];
        const params = [];
        if (target.request_id) {
            orClauses.push('request_id = ?');
            params.push(target.request_id);
        }
        if (target.trace_id) {
            orClauses.push('trace_id = ?');
            params.push(target.trace_id);
        }
        if (target.order_id) {
            orClauses.push('order_id = ?');
            params.push(target.order_id);
        }
        if (target.transaction_id) {
            orClauses.push('transaction_id = ?');
            params.push(target.transaction_id);
        }
        if (target.reference_code) {
            orClauses.push('reference_code = ?');
            params.push(target.reference_code);
        }
        if (orClauses.length === 0) {
            res.status(200).json({
                success: true,
                data: [formatLogRow(target, false)],
            });
            return;
        }
        const [relatedRows] = await database_js_1.default.query(`SELECT *
       FROM system_logs
       WHERE deleted_at IS NULL
         AND (${orClauses.join(' OR ')})
       ORDER BY occurred_at ASC, id ASC
       LIMIT 50`, params);
        res.status(200).json({
            success: true,
            data: (relatedRows || []).map((r) => formatLogRow(r, false)),
        });
    }
    catch (err) {
        console.error('Error getRelatedSystemLogs:', err);
        res.status(500).json({ success: false, message: 'Gagal memuat rangkaian event terkait' });
    }
};
exports.getRelatedSystemLogs = getRelatedSystemLogs;
// ------------------------------------------------------------
//  5. POST /api/admin/logs/:eventId/acknowledge — Tandai Diperiksa (§11)
// ------------------------------------------------------------
const acknowledgeSystemLog = async (req, res) => {
    res.locals['skipSystemLog'] = true;
    try {
        await ensureReady();
        const { eventId } = req.params;
        const adminId = req.user?.id || res.locals['userId'] || 1;
        const [result] = await database_js_1.default.query(`UPDATE system_logs
       SET acknowledged_at = NOW(), acknowledged_by = ?
       WHERE event_id = ?`, [adminId, eventId]);
        if (!result?.affectedRows) {
            res.status(404).json({ success: false, message: 'Log tidak ditemukan' });
            return;
        }
        res.status(200).json({
            success: true,
            message: 'Event berhasil ditandai telah diperiksa',
            data: { eventId, acknowledgedAt: new Date().toISOString(), acknowledgedBy: adminId },
        });
    }
    catch (err) {
        console.error('Error acknowledgeSystemLog:', err);
        res.status(500).json({ success: false, message: 'Gagal menandai log' });
    }
};
exports.acknowledgeSystemLog = acknowledgeSystemLog;
// ------------------------------------------------------------
//  6. GET /api/admin/logs/export — Unduh CSV Aman & Audit (§8.5, §11)
// ------------------------------------------------------------
const escapeCsvCell = (val) => {
    if (val === null || val === undefined)
        return '""';
    const str = String(val).replace(/"/g, '""').replace(/\r?\n/g, ' ');
    return `"${str}"`;
};
const formatWibTimestamp = (dateInput) => {
    try {
        const d = new Date(dateInput);
        return d.toLocaleString('id-ID', {
            timeZone: 'Asia/Jakarta',
            year: 'numeric',
            month: '2-digit',
            day: '2-digit',
            hour: '2-digit',
            minute: '2-digit',
            second: '2-digit',
            hour12: false,
        }) + ' WIB';
    }
    catch {
        return String(dateInput || '-');
    }
};
const exportSystemLogsCsv = async (req, res) => {
    try {
        await ensureReady();
        const adminId = req.user?.id || res.locals['userId'] || 1;
        const { whereSql, params, rangeLabel } = buildLogFilterWhere(req.query);
        const [rows] = await database_js_1.default.query(`SELECT event_id, occurred_at, severity, category, event_name, status_code,
              http_method, route_template, message, user_id, role, source, service,
              duration_ms, request_id, order_id, transaction_id, reference_code
       FROM system_logs
       ${whereSql}
       ORDER BY occurred_at DESC, id DESC
       LIMIT 5000`, params);
        const header = [
            'Waktu (WIB)',
            'Event ID',
            'Level',
            'Kategori',
            'Event',
            'Status HTTP',
            'Method & Route',
            'Ringkasan',
            'Aktor',
            'Sumber / Layanan',
            'Durasi (ms)',
            'Request ID',
            'Order ID',
            'Transaction / Ref ID',
        ].join(',');
        const csvLines = (rows || []).map((r) => {
            const actor = r.user_id ? `${r.role || 'user'}#${r.user_id}` : r.role || 'guest';
            const routeInfo = r.http_method ? `${r.http_method} ${r.route_template || ''}` : '-';
            const txRef = r.reference_code || (r.transaction_id ? `#${r.transaction_id}` : '-');
            return [
                escapeCsvCell(formatWibTimestamp(r.occurred_at)),
                escapeCsvCell(r.event_id),
                escapeCsvCell(r.severity),
                escapeCsvCell(r.category),
                escapeCsvCell(r.event_name),
                escapeCsvCell(r.status_code ?? 0),
                escapeCsvCell(routeInfo),
                escapeCsvCell(r.message),
                escapeCsvCell(actor),
                escapeCsvCell(`${r.source}/${r.service}`),
                escapeCsvCell(r.duration_ms ?? 0),
                escapeCsvCell(r.request_id || '-'),
                escapeCsvCell(r.order_id || '-'),
                escapeCsvCell(txRef),
            ].join(',');
        });
        const csvContent = '\uFEFF' + [header, ...csvLines].join('\r\n');
        const datePart = new Date().toISOString().split('T')[0];
        const filename = `dinoyocraft-logs-${datePart}-${rangeLabel}.csv`;
        // Catat audit ekspor (§8.5)
        await (0, loggingService_js_1.logSystemEvent)({
            category: 'admin_audit',
            eventName: 'admin_audit.logs_exported',
            severity: 'info',
            outcome: 'success',
            message: `Admin #${adminId} mengekspor ${(rows || []).length} baris log ke CSV (${filename})`,
            source: 'backend',
            service: 'admin-logs',
            correlation: { requestId: res.locals['requestId'], userId: Number(adminId), role: 'admin' },
            metadata: {
                exportedRows: (rows || []).length,
                range: req.query.range || 'live',
                category: req.query.category || 'all',
                severity: req.query.severity || 'all',
            },
        });
        res.setHeader('Content-Type', 'text/csv; charset=utf-8');
        res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
        res.status(200).send(csvContent);
    }
    catch (err) {
        console.error('Error exportSystemLogsCsv:', err);
        res.status(500).json({ success: false, message: 'Gagal mengekspor log ke CSV' });
    }
};
exports.exportSystemLogsCsv = exportSystemLogsCsv;
// ------------------------------------------------------------
//  7. DELETE /api/admin/logs/:eventId — Soft Delete Satu Log (§8.5, §11)
// ------------------------------------------------------------
const softDeleteSystemLog = async (req, res) => {
    res.locals['skipSystemLog'] = true;
    try {
        await ensureReady();
        const { eventId } = req.params;
        const reason = req.body?.reason || req.query?.reason || 'Dihapus oleh Admin';
        const adminId = req.user?.id || res.locals['userId'] || 1;
        const [check] = await database_js_1.default.query('SELECT id FROM system_logs WHERE event_id = ? LIMIT 1', [eventId]);
        if (!check || check.length === 0) {
            res.status(404).json({ success: false, message: 'Log tidak ditemukan' });
            return;
        }
        await database_js_1.default.query(`UPDATE system_logs
       SET deleted_at = NOW(), deleted_by = ?, delete_reason = ?
       WHERE event_id = ?`, [adminId, String(reason).slice(0, 250), eventId]);
        res.status(200).json({
            success: true,
            message: `Log berhasil dipindahkan ke tempat sampah (otomatis terhapus permanen setelah ${loggingService_js_1.TRASH_RETENTION_DAYS} hari).`,
            data: { eventId },
        });
    }
    catch (err) {
        console.error('Error softDeleteSystemLog:', err);
        res.status(500).json({ success: false, message: 'Gagal menghapus log' });
    }
};
exports.softDeleteSystemLog = softDeleteSystemLog;
// ------------------------------------------------------------
//  8. POST /api/admin/logs/bulk-delete — Soft Delete Massal (§8.5, §11)
// ------------------------------------------------------------
const bulkDeleteSystemLogs = async (req, res) => {
    res.locals['skipSystemLog'] = true;
    try {
        await ensureReady();
        const adminId = req.user?.id || res.locals['userId'] || 1;
        const { eventIds, filter, reason = 'Hapus massal oleh Admin' } = req.body || {};
        let affectedCount = 0;
        if (Array.isArray(eventIds) && eventIds.length > 0) {
            const cleanIds = eventIds.map((id) => String(id).trim()).filter(Boolean);
            if (cleanIds.length > 0) {
                const placeholders = cleanIds.map(() => '?').join(',');
                const [result] = await database_js_1.default.query(`UPDATE system_logs
           SET deleted_at = NOW(), deleted_by = ?, delete_reason = ?
           WHERE event_id IN (${placeholders})
             AND deleted_at IS NULL`, [adminId, String(reason).slice(0, 250), ...cleanIds]);
                affectedCount = Number(result?.affectedRows || 0);
            }
        }
        else if (filter && typeof filter === 'object') {
            const safeFilter = { ...filter };
            delete safeFilter.cursor;
            delete safeFilter.onlyDeleted;
            delete safeFilter.includeDeleted;
            const { whereSql, params } = buildLogFilterWhere(safeFilter);
            const finalWhere = whereSql || 'WHERE deleted_at IS NULL';
            const [result] = await database_js_1.default.query(`UPDATE system_logs
         SET deleted_at = NOW(), deleted_by = ?, delete_reason = ?
         ${finalWhere}`, [adminId, String(reason).slice(0, 250), ...params]);
            affectedCount = Number(result?.affectedRows || 0);
        }
        else {
            res.status(400).json({
                success: false,
                message: 'Pilih daftar eventIds atau filter untuk dihapus.',
            });
            return;
        }
        res.status(200).json({
            success: true,
            message: `${affectedCount} log berhasil dipindahkan ke tempat sampah (otomatis terhapus permanen setelah ${loggingService_js_1.TRASH_RETENTION_DAYS} hari).`,
            data: { affectedCount },
        });
    }
    catch (err) {
        console.error('Error bulkDeleteSystemLogs:', err);
        res.status(500).json({ success: false, message: 'Gagal melakukan hapus massal log' });
    }
};
exports.bulkDeleteSystemLogs = bulkDeleteSystemLogs;
// ------------------------------------------------------------
//  9. POST /api/admin/logs/:eventId/restore — Pulihkan Soft-Delete (§8.5, §11)
// ------------------------------------------------------------
const restoreSystemLog = async (req, res) => {
    res.locals['skipSystemLog'] = true;
    try {
        await ensureReady();
        const { eventId } = req.params;
        const [result] = await database_js_1.default.query(`UPDATE system_logs
       SET deleted_at = NULL, deleted_by = NULL, delete_reason = NULL
       WHERE event_id = ? AND deleted_at IS NOT NULL`, [eventId]);
        if (!result?.affectedRows) {
            res.status(404).json({
                success: false,
                message: 'Log tidak ditemukan atau sudah aktif kembali.',
            });
            return;
        }
        res.status(200).json({
            success: true,
            message: 'Log berhasil dipulihkan kembali ke daftar aktif.',
            data: { eventId },
        });
    }
    catch (err) {
        console.error('Error restoreSystemLog:', err);
        res.status(500).json({ success: false, message: 'Gagal memulihkan log' });
    }
};
exports.restoreSystemLog = restoreSystemLog;
// ------------------------------------------------------------
//  10. DELETE /api/admin/logs/:eventId/purge — Purge Permanen (§8.5, §11)
// ------------------------------------------------------------
const purgeSystemLog = async (req, res) => {
    res.locals['skipSystemLog'] = true;
    try {
        await ensureReady();
        const { eventId } = req.params;
        const [result] = await database_js_1.default.query('DELETE FROM system_logs WHERE event_id = ?', [eventId]);
        if (!result?.affectedRows) {
            res.status(404).json({ success: false, message: 'Log tidak ditemukan' });
            return;
        }
        res.status(200).json({
            success: true,
            message: 'Log telah dihapus secara permanen dari database.',
            data: { eventId },
        });
    }
    catch (err) {
        console.error('Error purgeSystemLog:', err);
        res.status(500).json({ success: false, message: 'Gagal melakukan purge log' });
    }
};
exports.purgeSystemLog = purgeSystemLog;
// ------------------------------------------------------------
//  10b. POST /api/admin/logs/bulk-purge — Hapus Permanen Massal / Kosongkan Tempat Sampah
// ------------------------------------------------------------
const bulkPurgeSystemLogs = async (req, res) => {
    res.locals['skipSystemLog'] = true;
    try {
        await ensureReady();
        const { eventIds, filter, emptyTrash } = req.body || {};
        let affectedCount = 0;
        if (Array.isArray(eventIds) && eventIds.length > 0) {
            const cleanIds = eventIds.map((id) => String(id).trim()).filter(Boolean);
            if (cleanIds.length > 0) {
                // Chunk jika jumlah ID besar
                const chunkSize = 500;
                for (let i = 0; i < cleanIds.length; i += chunkSize) {
                    const slice = cleanIds.slice(i, i + chunkSize);
                    const placeholders = slice.map(() => '?').join(',');
                    const [result] = await database_js_1.default.query(`DELETE FROM system_logs WHERE event_id IN (${placeholders})`, slice);
                    affectedCount += Number(result?.affectedRows || 0);
                }
            }
        }
        else if (emptyTrash === true) {
            const [result] = await database_js_1.default.query('DELETE FROM system_logs WHERE deleted_at IS NOT NULL');
            affectedCount = Number(result?.affectedRows || 0);
        }
        else if (filter && typeof filter === 'object') {
            const trashFilter = { ...filter, onlyDeleted: 'true' };
            delete trashFilter.cursor;
            const { whereSql, params } = buildLogFilterWhere(trashFilter);
            const finalWhere = whereSql || 'WHERE deleted_at IS NOT NULL';
            const [result] = await database_js_1.default.query(`DELETE FROM system_logs ${finalWhere}`, params);
            affectedCount = Number(result?.affectedRows || 0);
        }
        else {
            res.status(400).json({
                success: false,
                message: 'Pilih daftar log atau kosongkan tempat sampah untuk dihapus permanen.',
            });
            return;
        }
        res.status(200).json({
            success: true,
            message: `${affectedCount} log berhasil dihapus secara permanen dari database.`,
            data: { affectedCount },
        });
    }
    catch (err) {
        console.error('Error bulkPurgeSystemLogs:', err);
        res.status(500).json({
            success: false,
            message: 'Gagal menghapus permanen log dari tempat sampah',
        });
    }
};
exports.bulkPurgeSystemLogs = bulkPurgeSystemLogs;
// ------------------------------------------------------------
//  11. POST /api/admin/logs/pusher-auth — Otorisasi Private Channel (§8.4, §12)
// ------------------------------------------------------------
const authorizePusherChannel = async (req, res) => {
    res.locals['skipSystemLog'] = true;
    try {
        const socketId = req.body?.socket_id;
        const channelName = req.body?.channel_name;
        if (!socketId || !channelName) {
            res.status(400).json({ success: false, message: 'socket_id dan channel_name wajib diisi' });
            return;
        }
        const pusher = (0, loggingService_js_1.getPusherClient)();
        if (!pusher) {
            res.status(200).json({ success: false, disabled: true, auth: '' });
            return;
        }
        const authResponse = pusher.authorizeChannel(String(socketId), String(channelName));
        res.status(200).send(authResponse);
    }
    catch (err) {
        console.error('Error authorizePusherChannel:', err);
        res.status(200).json({ success: false, disabled: true, auth: '' });
    }
};
exports.authorizePusherChannel = authorizePusherChannel;
// ------------------------------------------------------------
//  12. POST /api/internal/logs/mobile — Ingest Log Aplikasi Mobile & Web (§10.3, §10.4, §11)
// ------------------------------------------------------------
const ingestClientLog = async (req, res) => {
    try {
        await ensureReady();
        const body = req.body || {};
        const events = Array.isArray(body.events) ? body.events.slice(0, 25) : [body];
        const ipRaw = req.headers['x-forwarded-for']?.split(',')[0]?.trim() ||
            req.socket?.remoteAddress ||
            'unknown';
        const userAgent = req.headers['user-agent'] || 'unknown';
        const recordedIds = [];
        for (const ev of events) {
            if (!ev || typeof ev !== 'object')
                continue;
            const rawCategory = String(ev.category || 'mobile').toLowerCase();
            const rawSeverity = String(ev.severity || 'warning').toLowerCase();
            const validSeverities = ['debug', 'info', 'success', 'warning', 'error', 'critical'];
            const severity = validSeverities.includes(rawSeverity) ? rawSeverity : 'warning';
            const source = ev.source === 'web' ? 'web' : 'mobile';
            const eventName = (0, loggingService_js_1.sanitizeText)(ev.eventName || ev.event || `${source}.client.event`).slice(0, 100);
            const message = (0, loggingService_js_1.sanitizeText)(ev.message || 'Client telemetry event').slice(0, 500);
            const id = await (0, loggingService_js_1.logSystemEvent)({
                category: rawCategory || 'mobile',
                eventName,
                severity,
                outcome: severity === 'error' || severity === 'critical' || severity === 'warning' ? 'failure' : 'info',
                message,
                source,
                service: (0, loggingService_js_1.sanitizeText)(ev.service || (source === 'web' ? 'web-client' : 'mobile-flutter')).slice(0, 60),
                http: ev.http
                    ? {
                        method: String(ev.http.method || 'GET').toUpperCase().slice(0, 10),
                        route: String(ev.http.route || '/').slice(0, 200),
                        statusCode: Number(ev.http.statusCode || 0),
                        durationMs: Number(ev.http.durationMs || 0),
                    }
                    : undefined,
                correlation: {
                    requestId: ev.requestId || res.locals['requestId'] || null,
                    userId: ev.userId ? Number(ev.userId) : null,
                    role: ev.role ? String(ev.role).slice(0, 30) : null,
                    orderId: ev.orderId ? Number(ev.orderId) : null,
                    transactionId: ev.transactionId ? Number(ev.transactionId) : null,
                },
                client: {
                    platform: (0, loggingService_js_1.sanitizeText)(ev.platform || (source === 'web' ? 'Web Browser' : 'Mobile Flutter')).slice(0, 50),
                    appVersion: (0, loggingService_js_1.sanitizeText)(ev.appVersion || '1.0.0').slice(0, 30),
                    ipMasked: (0, loggingService_js_1.maskIp)(ipRaw),
                    userAgent,
                },
                error: ev.error
                    ? {
                        code: (0, loggingService_js_1.sanitizeText)(ev.error.code || 'CLIENT_ERR').slice(0, 60),
                        name: (0, loggingService_js_1.sanitizeText)(ev.error.name || 'ClientError').slice(0, 100),
                        message: (0, loggingService_js_1.sanitizeText)(ev.error.message || message).slice(0, 400),
                    }
                    : undefined,
                metadata: (0, loggingService_js_1.sanitizeMetadata)({
                    ...ev.metadata,
                    crashlyticsRef: ev.crashlyticsRef || ev.metadata?.crashlyticsRef || undefined,
                }),
            });
            if (id)
                recordedIds.push(id);
        }
        res.status(201).json({
            success: true,
            message: 'Telemetry log berhasil diterima',
            data: { recordedCount: recordedIds.length, eventIds: recordedIds },
        });
    }
    catch (err) {
        console.error('Error ingestClientLog:', err);
        res.status(500).json({ success: false, message: 'Gagal menyimpan telemetry log' });
    }
};
exports.ingestClientLog = ingestClientLog;
//# sourceMappingURL=systemLogController.js.map