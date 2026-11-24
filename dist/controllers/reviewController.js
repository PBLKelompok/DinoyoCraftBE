"use strict";
// ============================================================
//  src/controllers/reviewController.ts
//  Controller Ulasan & Rating Produk Keramik
// ============================================================
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.voteHelpful = exports.replyReview = exports.createReview = exports.getStoreReviews = exports.getProductReviews = void 0;
const database_js_1 = __importDefault(require("../config/database.js"));
const response_js_1 = require("../utils/response.js");
const uploadMiddleware_js_1 = require("../middlewares/uploadMiddleware.js");
const getProductReviews = async (req, res) => {
    try {
        const { productId } = req.params;
        const [reviews] = await database_js_1.default.query(`SELECT 
         r.id,
         r.rating,
         r.variant,
         r.comment,
         r.photo_urls,
         r.helpful_count,
         r.seller_reply,
         r.replied_at,
         r.created_at,
         u.name AS user_name,
         u.avatar_url AS user_avatar
       FROM reviews r
       JOIN users u ON r.user_id = u.id
       WHERE r.product_id = ?
       ORDER BY r.id DESC`, [productId]);
        const formattedReviews = reviews.map((rev) => {
            let photos = [];
            if (typeof rev.photo_urls === 'string') {
                try {
                    photos = JSON.parse(rev.photo_urls);
                }
                catch {
                    photos = [];
                }
            }
            else if (Array.isArray(rev.photo_urls)) {
                photos = rev.photo_urls;
            }
            return { ...rev, photo_urls: photos };
        });
        // Hitung ringkasan rating
        const totalReviews = formattedReviews.length;
        const avgRating = totalReviews > 0
            ? Number((formattedReviews.reduce((acc, curr) => acc + curr.rating, 0) / totalReviews).toFixed(1))
            : 0;
        const distribution = { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 };
        formattedReviews.forEach((rev) => {
            if (distribution[rev.rating] !== undefined) {
                distribution[rev.rating]++;
            }
        });
        (0, response_js_1.sendSuccess)(res, {
            totalReviews,
            avgRating,
            distribution,
            reviews: formattedReviews,
        }, 'Daftar ulasan produk berhasil diambil.');
    }
    catch (error) {
        console.error('❌ [getProductReviews] Error:', error);
        (0, response_js_1.sendError)(res, 'Gagal mengambil ulasan produk.');
    }
};
exports.getProductReviews = getProductReviews;
const getStoreReviews = async (req, res) => {
    try {
        const mitraIdParam = req.query['mitra_id'] ?? req.query['store_id'];
        const storeNameParam = typeof req.query['store'] === 'string' ? req.query['store'].trim() : '';
        let mitraId = mitraIdParam !== undefined && !isNaN(Number(mitraIdParam)) && Number(mitraIdParam) > 0
            ? Number(mitraIdParam)
            : null;
        if (!mitraId && storeNameParam) {
            const [mRows] = await database_js_1.default.query('SELECT id FROM mitra_profiles WHERE LOWER(TRIM(store_name)) = LOWER(TRIM(?)) OR store_name LIKE ? LIMIT 1', [storeNameParam, `%${storeNameParam}%`]);
            if (mRows && mRows.length > 0) {
                mitraId = Number(mRows[0].id);
            }
        }
        let query = `
      SELECT 
        r.id,
        r.product_id,
        p.name AS product_name,
        m.store_name,
        r.rating,
        r.variant,
        r.comment,
        r.photo_urls,
        r.helpful_count,
        r.seller_reply,
        r.replied_at,
        r.created_at,
        u.name AS user_name,
        u.avatar_url AS user_avatar
      FROM reviews r
      JOIN products p ON r.product_id = p.id
      JOIN mitra_profiles m ON p.mitra_id = m.id
      JOIN users u ON r.user_id = u.id
      WHERE p.is_deleted = 0
    `;
        const params = [];
        if (mitraId) {
            query += ' AND p.mitra_id = ?';
            params.push(mitraId);
        }
        query += ' ORDER BY r.id DESC LIMIT 100';
        const [reviews] = await database_js_1.default.query(query, params);
        const formattedReviews = (reviews || []).map((rev) => {
            let photos = [];
            if (typeof rev.photo_urls === 'string') {
                try {
                    photos = JSON.parse(rev.photo_urls);
                }
                catch {
                    photos = [];
                }
            }
            else if (Array.isArray(rev.photo_urls)) {
                photos = rev.photo_urls;
            }
            return { ...rev, photo_urls: photos };
        });
        const totalReviews = formattedReviews.length;
        const avgRating = totalReviews > 0
            ? Number((formattedReviews.reduce((acc, curr) => acc + Number(curr.rating || 0), 0) / totalReviews).toFixed(1))
            : 0;
        const distribution = { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 };
        formattedReviews.forEach((rev) => {
            const rt = Number(rev.rating);
            if (distribution[rt] !== undefined) {
                distribution[rt]++;
            }
        });
        (0, response_js_1.sendSuccess)(res, {
            totalReviews,
            avgRating,
            distribution,
            reviews: formattedReviews,
        }, 'Daftar ulasan toko berhasil diambil.');
    }
    catch (error) {
        console.error('❌ [getStoreReviews] Error:', error);
        (0, response_js_1.sendError)(res, 'Gagal mengambil ulasan toko.');
    }
};
exports.getStoreReviews = getStoreReviews;
const createReview = async (req, res) => {
    const connection = await database_js_1.default.getConnection();
    try {
        await connection.beginTransaction();
        const userId = res.locals['userId'];
        const { product_id, order_item_id, rating, variant, comment, photo_urls } = req.body;
        // Ekstrak foto ulasan dari multipart upload (jika ada) + photo_urls dari JSON/string
        const collectedPhotos = [];
        if (Array.isArray(photo_urls)) {
            collectedPhotos.push(...photo_urls.map(String).filter(Boolean));
        }
        else if (typeof photo_urls === 'string' && photo_urls.trim()) {
            try {
                const parsed = JSON.parse(photo_urls);
                if (Array.isArray(parsed)) {
                    collectedPhotos.push(...parsed.map(String).filter(Boolean));
                }
                else {
                    collectedPhotos.push(photo_urls.trim());
                }
            }
            catch {
                collectedPhotos.push(photo_urls.trim());
            }
        }
        const reqFiles = req.files;
        if (Array.isArray(reqFiles)) {
            for (const f of reqFiles) {
                const fileUrl = (0, uploadMiddleware_js_1.getUploadedFileUrl)(f);
                if (fileUrl) {
                    collectedPhotos.push(fileUrl);
                }
            }
        }
        // 1. Cek apakah produk valid
        const [products] = await connection.query('SELECT id, mitra_id FROM products WHERE id = ? AND is_deleted = 0', [product_id]);
        if (products.length === 0) {
            await connection.rollback();
            (0, response_js_1.sendNotFound)(res, 'Produk tidak ditemukan.');
            return;
        }
        const mitraId = products[0].mitra_id;
        // 2. Simpan ulasan (atau perbarui jika order_item_id yang sama sudah pernah diulas oleh user ini)
        let reviewInsertId = 0;
        if (order_item_id) {
            const [existingRev] = await connection.query('SELECT id FROM reviews WHERE user_id = ? AND order_item_id = ? LIMIT 1', [userId, order_item_id]);
            if (existingRev && existingRev.length > 0) {
                reviewInsertId = existingRev[0].id;
                await connection.query(`UPDATE reviews SET rating = ?, variant = COALESCE(?, variant), comment = ?, photo_urls = COALESCE(?, photo_urls), updated_at = NOW()
           WHERE id = ?`, [
                    rating,
                    variant || null,
                    comment || null,
                    collectedPhotos.length > 0 ? JSON.stringify(collectedPhotos) : null,
                    reviewInsertId,
                ]);
            }
        }
        if (!reviewInsertId) {
            const [result] = await connection.query(`INSERT INTO reviews (product_id, user_id, order_item_id, rating, variant, comment, photo_urls)
         VALUES (?, ?, ?, ?, ?, ?, ?)`, [
                product_id,
                userId,
                order_item_id || null,
                rating,
                variant || null,
                comment || null,
                collectedPhotos.length > 0 ? JSON.stringify(collectedPhotos) : null,
            ]);
            reviewInsertId = result.insertId;
        }
        // 3. Update cache rating produk
        const [prodStats] = await connection.query('SELECT COUNT(*) as total, AVG(rating) as avg_rating FROM reviews WHERE product_id = ?', [product_id]);
        const prodTotal = prodStats[0]?.total || 0;
        const prodAvg = prodStats[0]?.avg_rating ? Number(prodStats[0].avg_rating).toFixed(2) : 0;
        await connection.query('UPDATE products SET rating = ?, total_reviews = ? WHERE id = ?', [prodAvg, prodTotal, product_id]);
        // 4. Update cache rating toko mitra
        const [mitraStats] = await connection.query(`SELECT COUNT(r.id) as total, AVG(r.rating) as avg_rating 
       FROM reviews r
       JOIN products p ON r.product_id = p.id
       WHERE p.mitra_id = ?`, [mitraId]);
        const mitraTotal = mitraStats[0]?.total || 0;
        const mitraAvg = mitraStats[0]?.avg_rating ? Number(mitraStats[0].avg_rating).toFixed(2) : 0;
        await connection.query('UPDATE mitra_profiles SET rating = ?, total_reviews = ? WHERE id = ?', [mitraAvg, mitraTotal, mitraId]);
        await connection.commit();
        const [newReview] = await database_js_1.default.query('SELECT * FROM reviews WHERE id = ?', [reviewInsertId]);
        (0, response_js_1.sendCreated)(res, newReview[0], 'Ulasan berhasil dikirim. Terima kasih atas masukan Anda!');
    }
    catch (error) {
        await connection.rollback();
        console.error('❌ [createReview] Error:', error);
        (0, response_js_1.sendError)(res, 'Gagal mengirim ulasan.');
    }
    finally {
        connection.release();
    }
};
exports.createReview = createReview;
const replyReview = async (req, res) => {
    try {
        const userId = res.locals['userId'];
        const role = res.locals['role'];
        const { id } = req.params;
        const { seller_reply } = req.body;
        const [reviewRows] = await database_js_1.default.query(`SELECT r.id, p.mitra_id, m.user_id AS mitra_user_id 
       FROM reviews r
       JOIN products p ON r.product_id = p.id
       JOIN mitra_profiles m ON p.mitra_id = m.id
       WHERE r.id = ?`, [id]);
        if (reviewRows.length === 0) {
            (0, response_js_1.sendNotFound)(res, 'Ulasan tidak ditemukan.');
            return;
        }
        const review = reviewRows[0];
        if (role !== 'admin' && review.mitra_user_id !== userId) {
            (0, response_js_1.sendForbidden)(res, 'Hanya pemilik toko mitra yang boleh membalas ulasan ini.');
            return;
        }
        await database_js_1.default.query('UPDATE reviews SET seller_reply = ?, replied_at = NOW() WHERE id = ?', [seller_reply, id]);
        (0, response_js_1.sendSuccess)(res, null, 'Balasan ulasan berhasil dikirim.');
    }
    catch (error) {
        console.error('❌ [replyReview] Error:', error);
        (0, response_js_1.sendError)(res, 'Gagal membalas ulasan.');
    }
};
exports.replyReview = replyReview;
const voteHelpful = async (req, res) => {
    try {
        const { id } = req.params;
        await database_js_1.default.query('UPDATE reviews SET helpful_count = helpful_count + 1 WHERE id = ?', [id]);
        (0, response_js_1.sendSuccess)(res, null, 'Terima kasih atas tanggapan Anda.');
    }
    catch (error) {
        console.error('❌ [voteHelpful] Error:', error);
        (0, response_js_1.sendError)(res, 'Gagal memberikan vote.');
    }
};
exports.voteHelpful = voteHelpful;
//# sourceMappingURL=reviewController.js.map