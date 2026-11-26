"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.requestMitraWithdrawal = exports.getMitraWallet = exports.getPublicMitraDetail = exports.getPublicMitraStores = exports.updateProduct = exports.getOrders = exports.getFinanceReport = exports.getDashboardMitra = void 0;
const database_js_1 = __importDefault(require("../config/database.js"));
const walletService_js_1 = require("../services/walletService.js");
const productController_js_1 = require("./productController.js");
const uploadMiddleware_js_1 = require("../middlewares/uploadMiddleware.js");
const getDashboardMitra = async (req, res) => {
    try {
        // 1. Ambil ID user dari JWT (res.locals atau req.user)
        const userId = req.user?.id || req.user?.userId || res.locals['userId'];
        if (!userId) {
            res.status(401).json({ success: false, message: 'Autentikasi gagal. User tidak ditemukan.' });
            return;
        }
        // 2. Cari profil mitra & user secara paralel
        const [[mitraRows], [userRows]] = await Promise.all([
            database_js_1.default.query('SELECT id, user_id, store_name FROM mitra_profiles WHERE user_id = ? LIMIT 1', [userId]),
            database_js_1.default.query('SELECT id, name FROM users WHERE id = ? LIMIT 1', [userId]),
        ]);
        const userName = userRows && userRows.length > 0 ? userRows[0].name : 'Mitra';
        const mitra = mitraRows && mitraRows.length > 0 ? mitraRows[0] : null;
        const mitraId = mitra ? mitra.id : null;
        const storeName = mitra?.store_name || userName;
        let totalProducts = 0;
        let totalOrders = 0;
        let activeBalance = 0;
        let kunjunganProfil = 0;
        let recentOrdersFormatted = [];
        if (mitraId) {
            const [[productCountRows], [orderCountRows], wallet, [orderRows], [visitorRows],] = await Promise.all([
                database_js_1.default.query('SELECT COUNT(*) AS total FROM products WHERE mitra_id = ? AND (is_deleted = 0 OR is_deleted IS NULL)', [mitraId]),
                database_js_1.default.query('SELECT COUNT(*) AS total FROM orders WHERE mitra_id = ?', [mitraId]),
                (0, walletService_js_1.getWalletSummary)(mitraId),
                database_js_1.default.query(`SELECT 
            o.id,
            o.created_at,
            o.status,
            COALESCE(u.name, 'Pembeli') AS customer_name,
            COALESCE((SELECT SUM(oi.quantity) FROM order_items oi WHERE oi.order_id = o.id), 1) AS total_items
          FROM orders o
          LEFT JOIN users u ON o.user_id = u.id
          WHERE o.mitra_id = ?
          ORDER BY o.created_at DESC
          LIMIT 5`, [mitraId]),
                database_js_1.default
                    .query(`SELECT COUNT(DISTINCT visitor_id) AS total FROM (
              SELECT user_id AS visitor_id FROM orders WHERE mitra_id = ? AND user_id IS NOT NULL AND user_id != ?
              UNION
              SELECT sender_id AS visitor_id FROM messages WHERE receiver_id = ? AND sender_id IS NOT NULL AND sender_id != ?
            ) AS store_visitors`, [mitraId, userId, userId, userId])
                    .catch(() => [[{ total: 0 }]]),
            ]);
            totalProducts = Number(productCountRows?.[0]?.total || 0);
            totalOrders = Number(orderCountRows?.[0]?.total || 0);
            activeBalance = Number(wallet?.saldo_tersedia || 0);
            kunjunganProfil = Number(visitorRows?.[0]?.total || 0);
            const statusMap = {
                pending: 'Menunggu Pembayaran',
                paid: 'Perlu Diproses',
                packed: 'Sedang Dikemas',
                shipped: 'Sedang Dikirim',
                completed: 'Selesai',
                cancelled: 'Dibatalkan',
            };
            recentOrdersFormatted = (orderRows || []).map((item) => {
                const orderDate = item.created_at ? new Date(item.created_at) : new Date();
                const dateStr = orderDate.toISOString().split('T')[0].replace(/-/g, '');
                return {
                    id: `ORD-${dateStr}-00${item.id}`,
                    items: Number(item.total_items || 1),
                    customer: item.customer_name,
                    status: statusMap[item.status] || item.status || 'Perlu Diproses',
                };
            });
        }
        // 5. Susun respons JSON yang siap di-consume frontend (tanpa angka dummy)
        res.status(200).json({
            success: true,
            data: {
                mitraName: storeName,
                stats: {
                    totalPesanan: totalOrders,
                    produkAktif: totalProducts,
                    saldoAktif: activeBalance,
                    kunjunganProfil,
                },
                recentOrders: recentOrdersFormatted,
            },
        });
    }
    catch (error) {
        console.error('Error fetching dashboard data:', error);
        res.status(500).json({ success: false, message: 'Terjadi kesalahan pada server' });
    }
};
exports.getDashboardMitra = getDashboardMitra;
// --- 1. ENDPOINT LAPORAN KEUANGAN ---
const getFinanceReport = async (req, res) => {
    try {
        const userId = req.user?.id || req.user?.userId || res.locals['userId'];
        if (!userId) {
            res.status(401).json({ success: false, message: 'Autentikasi gagal. User tidak ditemukan.' });
            return;
        }
        const [mitraRows] = await database_js_1.default.query('SELECT id, user_id, store_name FROM mitra_profiles WHERE user_id = ? LIMIT 1', [userId]);
        const mitra = mitraRows && mitraRows.length > 0 ? mitraRows[0] : null;
        if (!mitra) {
            res.status(404).json({ success: false, message: 'Mitra tidak ditemukan' });
            return;
        }
        const mitraId = mitra.id;
        // Ambil order untuk kalkulasi saldo
        const [orders] = await database_js_1.default.query('SELECT id, total_amount, status, created_at FROM orders WHERE mitra_id = ?', [mitraId]);
        let saldoAktif = 0;
        let pendapatanTertunda = 0;
        orders.forEach((order) => {
            const total = Number(order.total_amount || 0);
            const status = (order.status || '').toLowerCase();
            if (status === 'completed' || status === 'delivered' || status === 'selesai') {
                saldoAktif += total;
            }
            else if (['pending', 'paid', 'packed', 'shipped', 'processing'].includes(status)) {
                pendapatanTertunda += total;
            }
        });
        // Ambil riwayat pesanan/transaksi terbaru untuk mitra ini
        const [recentOrderRows] = await database_js_1.default.query(`SELECT id, created_at, total_amount, status 
       FROM orders 
       WHERE mitra_id = ? 
       ORDER BY created_at DESC 
       LIMIT 10`, [mitraId]);
        let riwayatTransaksi = recentOrderRows.map((o) => {
            const d = o.created_at ? new Date(o.created_at) : new Date();
            const tanggal = d.toLocaleDateString('id-ID', { day: 'numeric', month: 'short', year: 'numeric' });
            const statusStr = (o.status || '').toLowerCase();
            const statusLabel = (statusStr === 'completed' || statusStr === 'selesai' || statusStr === 'delivered')
                ? 'Selesai'
                : (statusStr === 'cancelled' ? 'Dibatalkan' : 'Tertunda');
            return {
                id: `TRX-${String(o.id).padStart(3, '0')}`,
                tanggal,
                deskripsi: `Penjualan - INV/${d.getFullYear()}/${String(d.getMonth() + 1).padStart(2, '0')}/00${o.id}`,
                status: statusLabel,
                nominal: Number(o.total_amount || 0)
            };
        });
        // Saldo & penarikan dari wallet ledger (konsisten dengan /mitra/wallet)
        const wallet = await (0, walletService_js_1.getWalletSummary)(mitraId);
        const withdrawals = await (0, walletService_js_1.listWithdrawals)(mitraId, 10);
        const chartData = await (0, walletService_js_1.getWeeklyChart)(mitraId);
        const chartBulanan = await (0, walletService_js_1.getMonthlyChart)(mitraId);
        res.json({
            success: true,
            data: {
                saldoAktif: wallet.saldo_tersedia,
                pendapatanTertunda: wallet.pendapatan_tertunda,
                totalDitarik: wallet.total_ditarik,
                minWithdrawal: wallet.min_withdrawal,
                withdrawalFee: wallet.withdrawal_fee,
                riwayatPenarikan: withdrawals,
                riwayatTransaksi,
                chartData,
                chartMingguan: chartData,
                chartBulanan: chartBulanan,
            }
        });
    }
    catch (error) {
        console.error('Error finance report:', error);
        res.status(500).json({ success: false, message: 'Server error' });
    }
};
exports.getFinanceReport = getFinanceReport;
// --- 2. ENDPOINT MANAJEMEN PESANAN ---
const getOrders = async (req, res) => {
    try {
        const userId = req.user?.id || req.user?.userId || res.locals['userId'];
        if (!userId) {
            res.status(401).json({ success: false, message: 'Autentikasi gagal. User tidak ditemukan.' });
            return;
        }
        const [mitraRows] = await database_js_1.default.query('SELECT id FROM mitra_profiles WHERE user_id = ? LIMIT 1', [userId]);
        const mitra = mitraRows && mitraRows.length > 0 ? mitraRows[0] : null;
        if (!mitra) {
            res.status(404).json({ success: false, message: 'Mitra tidak ditemukan' });
            return;
        }
        const mitraId = mitra.id;
        // Cari pesanan milik mitra ini beserta rincian ongkir, alamat, dan pembayaran Midtrans
        const [orderRows] = await database_js_1.default.query(`SELECT 
        o.id,
        o.user_id AS customer_id,
        o.created_at,
        o.status,
        o.total_amount,
        o.shipping_cost,
        o.shipping_method,
        o.tracking_number,
        o.customer_notes,
        COALESCE(u.name, 'Customer') AS customer_name,
        u.avatar_url AS customer_avatar,
        a.recipient_name,
        a.phone AS recipient_phone,
        a.full_address,
        a.city,
        a.postal_code,
        t.reference_code,
        t.transaction_type AS payment_method,
        t.payment_type,
        t.bank,
        t.gateway,
        t.gateway_fee,
        t.status AS payment_status,
        t.paid_at,
        t.expiry_time
      FROM orders o
      LEFT JOIN users u ON o.user_id = u.id
      LEFT JOIN user_addresses a ON o.address_id = a.id
      LEFT JOIN transactions t ON o.transaction_id = t.id
      WHERE o.mitra_id = ?
      ORDER BY o.created_at DESC`, [mitraId]);
        if (orderRows.length === 0) {
            res.json({ success: true, data: [] });
            return;
        }
        const orderIds = orderRows.map((o) => o.id);
        const placeholders = orderIds.map(() => '?').join(',');
        // Ambil order items beserta ulasan pembeli (jika sudah selesai & diulas)
        const [itemRows] = await database_js_1.default.query(`SELECT 
        oi.id AS order_item_id,
        oi.order_id,
        oi.product_id,
        oi.quantity,
        oi.unit_price,
        oi.variant,
        p.name AS product_name,
        p.image_urls,
        r.id AS review_id,
        r.rating AS review_rating,
        r.comment AS review_comment,
        r.photo_urls AS review_photos,
        r.seller_reply AS review_reply
      FROM order_items oi
      JOIN products p ON oi.product_id = p.id
      LEFT JOIN reviews r ON r.order_item_id = oi.id
      WHERE oi.order_id IN (${placeholders})`, orderIds);
        // Group items & review by order_id
        const itemsByOrder = {};
        const reviewByOrder = {};
        for (const item of itemRows) {
            if (!itemsByOrder[item.order_id]) {
                itemsByOrder[item.order_id] = [];
            }
            let firstImage;
            if (Array.isArray(item.image_urls) && item.image_urls.length > 0) {
                firstImage = String(item.image_urls[0]);
            }
            else if (typeof item.image_urls === 'string' && item.image_urls.trim()) {
                try {
                    const parsed = JSON.parse(item.image_urls);
                    if (Array.isArray(parsed) && parsed.length > 0) {
                        firstImage = String(parsed[0]);
                    }
                    else {
                        firstImage = item.image_urls.trim();
                    }
                }
                catch {
                    firstImage = item.image_urls.trim();
                }
            }
            itemsByOrder[item.order_id].push({
                id: item.order_item_id,
                productId: item.product_id,
                productName: item.product_name,
                quantity: item.quantity,
                price: Number(item.unit_price),
                variantName: item.variant || undefined,
                image: firstImage,
            });
            if (item.review_id && !reviewByOrder[item.order_id]) {
                let firstReviewPhoto;
                try {
                    if (Array.isArray(item.review_photos) && item.review_photos.length > 0) {
                        firstReviewPhoto = String(item.review_photos[0]);
                    }
                    else if (typeof item.review_photos === 'string' && item.review_photos.trim()) {
                        const parsedPhotos = JSON.parse(item.review_photos);
                        if (Array.isArray(parsedPhotos) && parsedPhotos.length > 0) {
                            firstReviewPhoto = String(parsedPhotos[0]);
                        }
                    }
                }
                catch { }
                reviewByOrder[item.order_id] = {
                    reviewId: item.review_id,
                    rating: Number(item.review_rating || 0),
                    ulasan: item.review_comment || '',
                    ulasanFoto: firstReviewPhoto,
                    balasanMitra: item.review_reply || undefined,
                };
            }
        }
        // Format respons
        const formattedOrders = orderRows.map((order) => {
            const orderDate = order.created_at ? new Date(order.created_at) : new Date();
            const dateStr = orderDate.toISOString().split('T')[0].replace(/-/g, '');
            const orderItems = itemsByOrder[order.id] || [];
            const orderReview = reviewByOrder[order.id] || null;
            const subtotalProduk = orderItems.reduce((sum, it) => sum + Number(it.price || 0) * Number(it.quantity || 1), 0);
            const totalAmount = Number(order.total_amount || 0);
            const shippingCost = Number(order.shipping_cost ?? Math.max(0, totalAmount - subtotalProduk));
            const gatewayFee = Number(order.gateway_fee || 0);
            const addressParts = [order.full_address, order.city, order.postal_code]
                .map((v) => (v ? String(v).trim() : ''))
                .filter(Boolean);
            return {
                id: order.id,
                orderId: `ORD-${dateStr}-00${order.id}`,
                referenceCode: order.reference_code || `#DNC-${order.id}`,
                customerId: order.customer_id ? Number(order.customer_id) : undefined,
                tanggal: order.created_at,
                customerName: order.customer_name || 'Customer',
                recipientName: order.recipient_name || order.customer_name || 'Customer',
                recipientPhone: order.recipient_phone || null,
                shippingAddress: addressParts.length > 0 ? addressParts.join(', ') : null,
                customerNotes: order.customer_notes || null,
                status: order.status,
                subtotalProduk,
                shippingCost,
                gatewayFee,
                totalBelanja: totalAmount,
                subtotalBersih: totalAmount,
                kurir: order.shipping_method || undefined,
                resi: order.tracking_number || undefined,
                payment_method: order.payment_method || null,
                payment_type: order.payment_type || null,
                bank: order.bank || null,
                gateway: order.gateway || 'midtrans',
                payment_status: order.payment_status || 'pending',
                paid_at: order.paid_at || null,
                expiry_time: order.expiry_time || null,
                reviewId: orderReview?.reviewId,
                rating: orderReview?.rating,
                ulasan: orderReview?.ulasan,
                ulasanAvatar: order.customer_avatar || undefined,
                ulasanFoto: orderReview?.ulasanFoto,
                balasanMitra: orderReview?.balasanMitra,
                items: orderItems
            };
        });
        res.json({ success: true, data: formattedOrders });
    }
    catch (error) {
        console.error('Error get orders:', error);
        res.status(500).json({ success: false, message: 'Server error' });
    }
};
exports.getOrders = getOrders;
// --- 3. ENDPOINT EDIT PRODUK (FIX KATALOG BUG) ---
const updateProduct = async (req, res) => {
    try {
        const { id } = req.params; // ID produk dari URL
        const { name, title, price, stock, category_id, description, variants, weight_gram } = req.body;
        const userId = req.user?.id || req.user?.userId || res.locals['userId'];
        if (!userId) {
            res.status(401).json({ success: false, message: 'Autentikasi gagal. User tidak ditemukan.' });
            return;
        }
        const [mitraRows] = await database_js_1.default.query('SELECT id FROM mitra_profiles WHERE user_id = ? LIMIT 1', [userId]);
        const mitra = mitraRows && mitraRows.length > 0 ? mitraRows[0] : null;
        if (!mitra) {
            res.status(404).json({ success: false, message: 'Profil mitra tidak ditemukan' });
            return;
        }
        const mitraId = mitra.id;
        // Pastikan produk yang diedit benar-benar milik mitra yang sedang login
        const [prodRows] = await database_js_1.default.query('SELECT * FROM products WHERE id = ? AND mitra_id = ? AND (is_deleted = 0 OR is_deleted IS NULL) LIMIT 1', [id, mitraId]);
        if (!prodRows || prodRows.length === 0) {
            res.status(404).json({ success: false, message: 'Produk tidak ditemukan atau Anda tidak memiliki akses' });
            return;
        }
        const existingProduct = prodRows[0];
        // Dapatkan data update (dukung 'name' atau 'title')
        const updatedName = name !== undefined ? name : (title !== undefined ? title : existingProduct.name);
        const updatedPrice = price !== undefined ? parseFloat(price) : existingProduct.price;
        const updatedDesc = description !== undefined ? description : existingProduct.description;
        const updatedWeight = weight_gram !== undefined
            ? Math.max(1, parseInt(weight_gram, 10) || 500)
            : (Number(existingProduct.weight_gram) || 500);
        let updatedVariantsJson;
        let updatedStock;
        if (variants !== undefined) {
            const normalized = (0, productController_js_1.serializeVariantsInput)(variants);
            if (normalized && normalized.length > 0) {
                updatedVariantsJson = JSON.stringify(normalized);
                updatedStock = normalized.reduce((sum, v) => sum + v.stock, 0);
            }
            else {
                updatedVariantsJson = null;
                updatedStock = stock !== undefined ? Math.max(0, parseInt(stock, 10) || 0) : Number(existingProduct.stock) || 0;
            }
        }
        else {
            const existingNormalized = (0, productController_js_1.serializeVariantsInput)(existingProduct.variants);
            updatedVariantsJson = existingNormalized ? JSON.stringify(existingNormalized) : null;
            updatedStock = stock !== undefined ? Math.max(0, parseInt(stock, 10) || 0) : Number(existingProduct.stock) || 0;
        }
        let updatedCategoryId = existingProduct.category_id;
        if (category_id !== undefined && String(category_id).trim() !== '') {
            updatedCategoryId = await (0, productController_js_1.resolveCategoryId)(category_id);
        }
        const uploadedFile = req.file;
        const uploadedFileUrl = (0, uploadMiddleware_js_1.getUploadedFileUrl)(uploadedFile);
        const rawImageUrl = typeof req.body?.image_url === 'string' ? String(req.body.image_url).trim() : '';
        const existingImages = (0, productController_js_1.parseImageUrls)(existingProduct.image_urls);
        const updatedImageUrlsJson = uploadedFileUrl
            ? JSON.stringify([uploadedFileUrl])
            : rawImageUrl && (rawImageUrl.startsWith('http://') || rawImageUrl.startsWith('https://'))
                ? JSON.stringify([rawImageUrl])
                : existingImages.length > 0
                    ? JSON.stringify(existingImages)
                    : null;
        // Lakukan update ke database
        await database_js_1.default.query(`UPDATE products 
       SET name = ?, description = ?, price = ?, stock = ?, weight_gram = ?, variants = ?, category_id = ?, image_urls = ?, updated_at = NOW() 
       WHERE id = ? AND mitra_id = ?`, [updatedName, updatedDesc, updatedPrice, updatedStock, updatedWeight, updatedVariantsJson, updatedCategoryId, updatedImageUrlsJson, id, mitraId]);
        const [updatedRows] = await database_js_1.default.query('SELECT * FROM products WHERE id = ? LIMIT 1', [id]);
        const saved = updatedRows && updatedRows.length > 0 ? updatedRows[0] : existingProduct;
        res.json({
            success: true,
            message: 'Produk berhasil diperbarui!',
            data: {
                ...saved,
                image_urls: (0, productController_js_1.parseImageUrls)(saved.image_urls),
                variants: (0, productController_js_1.parseVariants)(saved.variants),
            }
        });
    }
    catch (error) {
        console.error('Error update product:', error);
        res.status(500).json({ success: false, message: 'Server error' });
    }
};
exports.updateProduct = updateProduct;
const getPublicMitraStores = async (req, res) => {
    try {
        const { search } = req.query;
        let query = `
      SELECT 
        m.id,
        m.user_id,
        m.store_name,
        m.store_name AS name,
        m.workshop_address,
        m.workshop_address AS location,
        m.whatsapp_number,
        m.started_year,
        m.description,
        m.website,
        m.instagram,
        COALESCE(NULLIF(m.banner_url, ''), 'https://images.unsplash.com/photo-1610701596007-11502861dcfa?q=80&w=1200&auto=format&fit=crop') AS banner_url,
        CASE 
          WHEN m.avatar_url IS NOT NULL AND m.avatar_url != '' AND m.avatar_url NOT LIKE '%googleusercontent.com%' AND m.avatar_url NOT LIKE '%google.com%' THEN m.avatar_url
          WHEN u.avatar_url IS NOT NULL AND u.avatar_url != '' AND u.avatar_url NOT LIKE '%googleusercontent.com%' AND u.avatar_url NOT LIKE '%google.com%' THEN u.avatar_url
          ELSE NULL 
        END AS avatar_url,
        CASE 
          WHEN m.avatar_url IS NOT NULL AND m.avatar_url != '' AND m.avatar_url NOT LIKE '%googleusercontent.com%' AND m.avatar_url NOT LIKE '%google.com%' THEN m.avatar_url
          WHEN u.avatar_url IS NOT NULL AND u.avatar_url != '' AND u.avatar_url NOT LIKE '%googleusercontent.com%' AND u.avatar_url NOT LIKE '%google.com%' THEN u.avatar_url
          ELSE NULL 
        END AS image,
        (SELECT COUNT(*) FROM products p WHERE p.mitra_id = m.id AND (p.is_deleted = 0 OR p.is_deleted IS NULL)) AS total_products,
        COALESCE((SELECT ROUND(AVG(r.rating), 1) FROM reviews r JOIN products p ON r.product_id = p.id WHERE p.mitra_id = m.id), 0) AS avg_rating,
        COALESCE((SELECT COUNT(*) FROM reviews r JOIN products p ON r.product_id = p.id WHERE p.mitra_id = m.id), 0) AS total_reviews
      FROM mitra_profiles m
      LEFT JOIN users u ON m.user_id = u.id
      WHERE m.is_active = 1 AND m.is_verified = 1
    `;
        const params = [];
        if (search) {
            query += ' AND (m.store_name LIKE ? OR m.description LIKE ?)';
            params.push(`%${search}%`, `%${search}%`);
        }
        query += ' ORDER BY m.id DESC';
        const [rows] = await database_js_1.default.query(query, params);
        const stores = rows.map((r) => {
            const totalReviews = Number(r.total_reviews) || 0;
            const rating = totalReviews > 0 ? Number(r.avg_rating) || 0 : 0;
            return {
                ...r,
                total_reviews: totalReviews,
                rating,
            };
        });
        res.status(200).json({
            success: true,
            message: 'Daftar toko mitra berhasil diambil',
            data: stores,
            meta: { timestamp: new Date().toISOString() }
        });
    }
    catch (error) {
        console.error('Error getPublicMitraStores:', error);
        res.status(500).json({ success: false, message: 'Gagal mengambil daftar toko' });
    }
};
exports.getPublicMitraStores = getPublicMitraStores;
const getPublicMitraDetail = async (req, res) => {
    try {
        const rawParam = String(req.params.id || '').trim();
        const toSlug = (val) => val
            .toLowerCase()
            .replace(/[^a-z0-9]+/g, '-')
            .replace(/^-+|-+$/g, '');
        let resolvedId = /^\d+$/.test(rawParam) ? Number(rawParam) : null;
        if (!resolvedId) {
            const tailMatch = /-(\d+)$/.exec(rawParam);
            if (tailMatch) {
                resolvedId = Number(tailMatch[1]);
            }
        }
        const baseStoreSelect = `SELECT 
        m.id,
        m.user_id,
        m.store_name,
        m.store_name AS name,
        m.workshop_address,
        m.workshop_address AS location,
        m.whatsapp_number,
        m.started_year,
        m.description,
        m.website,
        m.instagram,
        COALESCE(NULLIF(m.banner_url, ''), 'https://images.unsplash.com/photo-1610701596007-11502861dcfa?q=80&w=1200&auto=format&fit=crop') AS banner_url,
        CASE 
          WHEN m.avatar_url IS NOT NULL AND m.avatar_url != '' AND m.avatar_url NOT LIKE '%googleusercontent.com%' AND m.avatar_url NOT LIKE '%google.com%' THEN m.avatar_url
          WHEN u.avatar_url IS NOT NULL AND u.avatar_url != '' AND u.avatar_url NOT LIKE '%googleusercontent.com%' AND u.avatar_url NOT LIKE '%google.com%' THEN u.avatar_url
          ELSE NULL 
        END AS avatar_url,
        CASE 
          WHEN m.avatar_url IS NOT NULL AND m.avatar_url != '' AND m.avatar_url NOT LIKE '%googleusercontent.com%' AND m.avatar_url NOT LIKE '%google.com%' THEN m.avatar_url
          WHEN u.avatar_url IS NOT NULL AND u.avatar_url != '' AND u.avatar_url NOT LIKE '%googleusercontent.com%' AND u.avatar_url NOT LIKE '%google.com%' THEN u.avatar_url
          ELSE NULL 
        END AS image,
        COALESCE((SELECT ROUND(AVG(r.rating), 1) FROM reviews r JOIN products p ON r.product_id = p.id WHERE p.mitra_id = m.id), 0) AS avg_rating,
        COALESCE((SELECT COUNT(*) FROM reviews r JOIN products p ON r.product_id = p.id WHERE p.mitra_id = m.id), 0) AS total_reviews
      FROM mitra_profiles m
      LEFT JOIN users u ON m.user_id = u.id`;
        let stores = [];
        if (resolvedId && resolvedId > 0) {
            const [byId] = await database_js_1.default.query(`${baseStoreSelect} WHERE m.id = ? AND m.is_active = 1 AND m.is_verified = 1 LIMIT 1`, [resolvedId]);
            stores = byId || [];
        }
        if ((!stores || stores.length === 0) && rawParam) {
            const targetSlug = toSlug(rawParam.replace(/-\d+$/, '')) || toSlug(rawParam);
            const [allActive] = await database_js_1.default.query(`${baseStoreSelect} WHERE m.is_active = 1 AND m.is_verified = 1`);
            const matched = (allActive || []).find((s) => toSlug(String(s.store_name || '')) === targetSlug);
            if (matched) {
                stores = [matched];
            }
        }
        if (!stores || stores.length === 0) {
            res.status(404).json({ success: false, message: 'Toko mitra tidak ditemukan' });
            return;
        }
        const id = stores[0].id;
        const totalStoreReviews = Number(stores[0].total_reviews) || 0;
        const store = {
            ...stores[0],
            total_reviews: totalStoreReviews,
            rating: totalStoreReviews > 0 ? Number(stores[0].avg_rating) || 0 : 0,
        };
        const [products] = await database_js_1.default.query(`SELECT 
        p.id,
        p.name,
        p.description,
        p.price,
        p.stock,
        p.weight_gram,
        p.variants,
        p.image_urls,
        p.rating,
        p.total_reviews,
        COALESCE(c.name, 'Keramik') AS category,
        COALESCE(
          (SELECT SUM(oi.quantity)
           FROM order_items oi
           JOIN orders o ON oi.order_id = o.id
           WHERE oi.product_id = p.id AND o.status != 'cancelled'),
          0
        ) AS sold_count
      FROM products p
      LEFT JOIN categories c ON p.category_id = c.id
      WHERE p.mitra_id = ? AND (p.is_deleted = 0 OR p.is_deleted IS NULL)
      ORDER BY p.created_at DESC`, [id]);
        const formattedProducts = products.map((p) => {
            const imageUrls = (0, productController_js_1.parseImageUrls)(p.image_urls);
            const img = imageUrls.length > 0 ? imageUrls[0] : '';
            const totalReviews = Number(p.total_reviews) || 0;
            const rating = totalReviews > 0 ? Number(p.rating) || 0 : 0;
            return {
                id: String(p.id),
                mitra_id: Number(id),
                name: p.name,
                title: p.name,
                description: p.description || '',
                price: Number(p.price),
                stock: Number(p.stock),
                weight_gram: Number(p.weight_gram) || 500,
                variants: (0, productController_js_1.parseVariants)(p.variants),
                category: p.category || 'Keramik',
                studio: store.store_name || store.name || 'Toko Keramik',
                store_name: store.store_name || store.name || 'Toko Keramik',
                workshop_address: store.workshop_address,
                rating,
                total_reviews: totalReviews,
                sold_count: Number(p.sold_count) || 0,
                image: img,
                image_url: img,
                images: imageUrls,
            };
        });
        res.status(200).json({
            success: true,
            message: 'Detail toko mitra berhasil diambil',
            data: {
                ...store,
                products: formattedProducts,
            },
            meta: { timestamp: new Date().toISOString() }
        });
    }
    catch (error) {
        console.error('Error getPublicMitraDetail:', error);
        res.status(500).json({ success: false, message: 'Gagal mengambil detail toko' });
    }
};
exports.getPublicMitraDetail = getPublicMitraDetail;
// ============================================================
// WALLET MITRA — saldo & penarikan dana
// ============================================================
/**
 * GET /api/mitra/wallet
 * Ringkasan saldo + riwayat pengajuan penarikan.
 */
const getMitraWallet = async (req, res) => {
    try {
        const userId = req.user?.id || req.user?.userId || res.locals['userId'];
        if (!userId) {
            res.status(401).json({ success: false, message: 'Autentikasi gagal.' });
            return;
        }
        const [mitraRows] = await database_js_1.default.query('SELECT id, user_id, store_name FROM mitra_profiles WHERE user_id = ? LIMIT 1', [userId]);
        if (!mitraRows || mitraRows.length === 0) {
            res.status(404).json({ success: false, message: 'Mitra tidak ditemukan' });
            return;
        }
        const summary = await (0, walletService_js_1.getWalletSummary)(mitraRows[0].id);
        const withdrawals = await (0, walletService_js_1.listWithdrawals)(mitraRows[0].id);
        const chartData = await (0, walletService_js_1.getWeeklyChart)(mitraRows[0].id);
        const chartBulanan = await (0, walletService_js_1.getMonthlyChart)(mitraRows[0].id);
        res.json({
            success: true,
            message: 'Saldo berhasil diambil.',
            data: {
                store_name: mitraRows[0].store_name,
                ...summary,
                chartData,
                chartMingguan: chartData,
                chartBulanan: chartBulanan,
                riwayat_penarikan: withdrawals,
            },
        });
    }
    catch (error) {
        console.error('Error getMitraWallet:', error);
        res.status(500).json({ success: false, message: 'Gagal mengambil data saldo.' });
    }
};
exports.getMitraWallet = getMitraWallet;
/**
 * POST /api/mitra/wallet/withdraw
 * Body: { amount, bank_name, account_number, account_name }
 */
const requestMitraWithdrawal = async (req, res) => {
    try {
        const userId = req.user?.id || req.user?.userId || res.locals['userId'];
        if (!userId) {
            res.status(401).json({ success: false, message: 'Autentikasi gagal.' });
            return;
        }
        const { amount, bank_name, account_number, account_name } = req.body;
        const result = await (0, walletService_js_1.requestWithdrawal)(userId, {
            amount: Number(amount),
            bank_name,
            account_number,
            account_name,
        });
        res.status(201).json({
            success: true,
            message: 'Penarikan berhasil diproses. Dana akan ditransfer ke rekening tujuan (1-2 hari kerja).',
            data: result,
        });
    }
    catch (error) {
        console.error('Error requestMitraWithdrawal:', error);
        res.status(error.status || 500).json({ success: false, message: error.message || 'Gagal mengajukan penarikan.' });
    }
};
exports.requestMitraWithdrawal = requestMitraWithdrawal;
//# sourceMappingURL=mitraController.js.map