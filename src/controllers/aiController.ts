// ============================================================
//  src/controllers/aiController.ts
//  Controller AI Multi-Provider — ClayBot CS, Asisten Mitra,
//  & Analisis Bisnis Keramik dengan Guardrail Ketat
// ============================================================

import { Request, Response } from 'express';
import pool from '../config/database.js';
import { sendSuccess, sendError, sendBadRequest } from '../utils/response.js';
import { anonymizePII, anonymizeObject } from '../utils/piiAnonymizer.js';
import { getAuthLocals } from '../middlewares/authMiddleware.js';
import {
  AiChatHistoryItem,
  AiRoleContext,
  PROVIDER_LABELS,
  buildGuardedSystemPrompt,
  cleanAiChatOutput,
  evaluatePlatformGuardrail,
  generateAiCompletion,
  getEffectiveAiSettings,
  sanitizeChatTextForAi,
} from '../services/aiProviderService.js';

// -------------------------------------------------------
// Helper: Prompt Engineering Analisis Bisnis JSON
// -------------------------------------------------------
const buildAnalysisPrompt = (
  context: string,
  productCategory: string,
  targetMarket: string,
  additionalNotes: string
): string => {
  return `
Kamu adalah AI konsultan bisnis keramik dan gerabah untuk UMKM di Kampung Dinoyo, Malang, Indonesia.

KONTEKS BISNIS:
${context}

KATEGORI PRODUK: ${productCategory}
TARGET PASAR: ${targetMarket}
CATATAN TAMBAHAN: ${additionalNotes}

TUGAS:
Berikan analisis bisnis yang komprehensif dan relevan untuk konteks UMKM keramik Dinoyo.

INSTRUKSI WAJIB:
1. Respons HARUS dalam format JSON yang valid (tanpa teks tambahan di luar JSON).
2. Gunakan Bahasa Indonesia yang profesional dan mudah dipahami UMKM.
3. Semua rekomendasi harus SPESIFIK untuk bisnis keramik/gerabah DinoyoCraft.
4. Estimasi harga dalam Rupiah (IDR).
5. confidence_score adalah tingkat keyakinan analisismu (0-100).

FORMAT OUTPUT JSON WAJIB (jangan tambah field lain):
{
  "rekomendasi_produk": ["string (maks 5 item)"],
  "analisis_pasar": "string (maks 200 kata)",
  "strategi_pemasaran": ["string (maks 5 item)"],
  "estimasi_harga": {
    "min": number,
    "max": number,
    "satuan": "string (contoh: per buah, per set)"
  },
  "potensi_risiko": ["string (maks 3 item)"],
  "kesimpulan": "string (maks 100 kata)",
  "confidence_score": number
}
`.trim();
};

const stripJsonFences = (raw: string): string => {
  const trimmed = raw.trim();
  const match = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  if (match && match[1]) return match[1].trim();
  const firstBrace = trimmed.indexOf('{');
  const lastBrace = trimmed.lastIndexOf('}');
  if (firstBrace !== -1 && lastBrace > firstBrace) {
    return trimmed.slice(firstBrace, lastBrace + 1);
  }
  return trimmed;
};

// -------------------------------------------------------
// Controller: POST /api/ai/analyze
// -------------------------------------------------------
export const analyzeWithAI = async (req: Request, res: Response): Promise<void> => {
  const startTime = Date.now();
  try {
    const { userId } = getAuthLocals(res);
    const {
      context,
      productCategory = 'Umum',
      targetMarket = 'Pasar Lokal',
      additionalNotes = '-',
    } = req.body;

    // 1. Cek guardrail ketat (anti prompt injection, copas kode error, topik luar)
    const guardrail = evaluatePlatformGuardrail(
      `${context}\n${productCategory}\n${additionalNotes}`,
      'id'
    );
    if (guardrail.blocked) {
      console.warn(`⚠️ Guardrail memblokir request analisis dari userId: ${userId} (${guardrail.reason})`);
      sendBadRequest(
        res,
        guardrail.reply || 'Konteks analisis mengandung konten di luar cakupan bisnis keramik DinoyoCraft.'
      );
      return;
    }

    // 2. Anonimisasi PII sebelum dikirim ke provider LLM
    const safeContext = anonymizePII(String(context || ''));
    const safeCategory = anonymizePII(String(productCategory || 'Umum'));
    const safeMarket = anonymizePII(String(targetMarket || 'Pasar Lokal'));
    const safeNotes = anonymizePII(String(additionalNotes || '-'));

    const settings = await getEffectiveAiSettings();
    if (!settings.apiKey) {
      sendError(
        res,
        'API Key AI belum dikonfigurasi oleh Admin pada menu Pengaturan AI.',
        503
      );
      return;
    }

    // 3. Bangun prompt terarah dengan guardrail platform
    const analysisPrompt = buildAnalysisPrompt(
      safeContext,
      safeCategory,
      safeMarket,
      safeNotes
    );
    const systemPrompt = buildGuardedSystemPrompt(
      settings.systemPrompt,
      'MODE KHUSUS: Output wajib berupa objek JSON murni sesuai skema analisis bisnis keramik UMKM DinoyoCraft.',
      'mitra'
    );

    // 4. Panggil LLM melalui provider aktif yang tersimpan
    const completion = await generateAiCompletion({
      apiKey: settings.apiKey,
      provider: settings.provider,
      model: settings.modelName,
      systemPrompt,
      userMessage: analysisPrompt,
      temperature: 0.4,
      maxTokens: 2048,
      jsonMode: true,
    });

    // 5. Parse JSON hasil LLM
    let parsedResult: Record<string, unknown>;
    try {
      parsedResult = JSON.parse(stripJsonFences(completion.text));
    } catch {
      console.error('❌ Provider AI mengembalikan non-JSON pada analyzeWithAI:', completion.text);
      sendError(res, 'AI mengembalikan format respons yang tidak valid. Silakan coba lagi.', 502);
      return;
    }

    // 6. Anonimisasi hasil AI sebagai pengaman ganda
    const sanitizedResult = anonymizeObject(parsedResult);
    const processingTimeMs = Date.now() - startTime;

    // 7. Simpan hasil analisis ke database
    const promptContext = JSON.stringify({
      context: safeContext,
      productCategory: safeCategory,
      targetMarket: safeMarket,
      additionalNotes: safeNotes,
    });

    await pool.execute(
      `INSERT INTO ai_analysis_results 
       (user_id, prompt_context, ai_response, model_used, processing_time_ms, created_at)
       VALUES (?, ?, ?, ?, ?, NOW())`,
      [
        userId,
        promptContext,
        JSON.stringify(sanitizedResult),
        completion.model,
        processingTimeMs,
      ]
    );

    sendSuccess(
      res,
      {
        analysis: sanitizedResult,
        metadata: {
          provider: completion.provider,
          providerLabel: PROVIDER_LABELS[completion.provider] || completion.provider,
          model: completion.model,
          processingTimeMs,
          inputWasAnonymized: true,
        },
      },
      'Analisis AI berhasil diselesaikan.'
    );
  } catch (err: unknown) {
    console.error('❌ AI Analysis Error:', err);
    sendError(res, 'Gagal menjalankan analisis AI.', 500, String(err));
  }
};

// -------------------------------------------------------
// Controller: GET /api/ai/history
// -------------------------------------------------------
export const getAiHistory = async (req: Request, res: Response): Promise<void> => {
  try {
    const { userId } = getAuthLocals(res);
    const page = Math.max(1, parseInt(req.query['page'] as string) || 1);
    const limit = Math.min(50, parseInt(req.query['limit'] as string) || 10);
    const offset = (page - 1) * limit;

    const [rows] = await pool.execute(
      `SELECT id, prompt_context, ai_response, model_used, processing_time_ms, created_at
       FROM ai_analysis_results
       WHERE user_id = ?
       ORDER BY created_at DESC
       LIMIT ? OFFSET ?`,
      [userId, limit, offset]
    );

    const [countRows]: any = await pool.execute(
      'SELECT COUNT(*) as total FROM ai_analysis_results WHERE user_id = ?',
      [userId]
    );
    const total = countRows[0]?.total ?? 0;

    sendSuccess(res, rows, 'Riwayat analisis berhasil diambil.', 200, {
      page,
      limit,
      total,
      totalPages: Math.ceil(total / limit),
    });
  } catch (err: unknown) {
    sendError(res, 'Gagal mengambil riwayat analisis.', 500, String(err));
  }
};

// -------------------------------------------------------
// Helper: Bangun Fallback Kontekstual Katalog (Bukan Topik Luar)
// -------------------------------------------------------
function buildCatalogFallbackReply(
  userMessage: string,
  locale: 'id' | 'en',
  roleContext: AiRoleContext,
  products: any[],
  stores: any[]
): string {
  const lower = userMessage.toLowerCase();

  // Cari kecocokan produk yang ditanyakan pengguna
  const keywords = lower
    .split(/[^a-z0-9]+/)
    .filter((w) => w.length >= 3 && !['harga', 'harganya', 'berapa', 'stok', 'toko', 'keramik', 'yang', 'ada', 'mau', 'cari', 'halo', 'hai'].includes(w));

  const matchedProducts = products.filter((p) => {
    const pName = String(p.name || '').toLowerCase();
    const pCat = String(p.category_name || '').toLowerCase();
    return keywords.some((kw) => pName.includes(kw) || pCat.includes(kw));
  });

  if (locale === 'en') {
    if (/^(halo|hi|hello|hey|good morning|good afternoon|good evening)\b/i.test(lower.trim())) {
      return 'Hello! I am ClayBot, DinoyoCraft’s official assistant. I can help you explore handmade Dinoyo ceramics, check prices & stock, learn about our wooden protective shipping, Midtrans payment options, or Ceramic Workshop sessions. What would you like to know?';
    }
    if (/(workshop|class|tour|wisata|learn)/i.test(lower)) {
      return 'Dinoyo Ceramic Village in Malang offers ±2-hour hands-on pottery & clay-making workshop sessions! Open the Workshop tab in the app to check schedules and reserve directly via WhatsApp with our artisans.';
    }
    if (matchedProducts.length > 0) {
      const list = matchedProducts
        .slice(0, 4)
        .map(
          (p) =>
            `• ${p.name} (${p.store_name}) — Rp ${Number(p.price).toLocaleString('id-ID')} (Stock: ${p.stock})`
        )
        .join('\n');
      return `Here are matching ceramic products currently in the DinoyoCraft catalog:\n\n${list}\n\nAll items are packed with layered bubble wrap and wooden crating for safe delivery. Need direct assistance? Tap "Chat dengan Customer Service Langsung".`;
    }
    return 'Hello! I am ClayBot from DinoyoCraft Malang. We offer authentic handmade Dinoyo ceramics with wooden protective packaging and Midtrans payments (QRIS / Virtual Account). Feel free to ask about products, orders, workshops, or contact our live CS anytime!';
  }

  if (roleContext === 'mitra') {
    if (/(harga|margin|promo|bundling|souvenir|suvenir|grosir)/i.test(lower)) {
      return 'Tips Penentuan Harga Mitra DinoyoCraft:\n1. Tentukan harga eceran dengan margin sehat di atas biaya bahan & pembakaran.\n2. Buat paket bundling suvenir (misal set 4 cangkir/vas) dengan harga khusus grosir untuk acara pernikahan atau kantor.\n3. Pastikan komponen biaya rangka kayu luar kota diperhitungkan di berat/pengiriman.';
    }
    if (/(pack|kirim|pecah|bubble|kayu|aman|resi)/i.test(lower)) {
      return 'SOP Pengemasan Aman Keramik DinoyoCraft:\n• Balut tiap keramik minimal 3 lapis bubble wrap.\n• Isi celah kardus dengan serutan kertas/foam padat agar tidak bergeser.\n• Untuk pengiriman luar kota/pulau, gunakan peti/rangka kayu pelindung & tempel stiker "Fragile — Keramik".';
    }
    return 'Halo Mitra Pengrajin DinoyoCraft! Layanan AI eksternal sedang mengalami antrean permintaan, namun Anda tetap dapat mengelola katalog produk, memproses pesanan ("Perlu Dikemas" & input resi), membalas Live Chat pembeli, serta menarik saldo di menu Laporan Keuangan. Butuh bantuan admin? Klik tab "CS DinoyoCraft" di menu Live Chat ya.';
  }

  if (/^(halo+|hai+|hi+|hello+|p+|pagi|siang|sore|malam|assalamualaikum)\b[!?. ]*$/i.test(lower.trim())) {
    return 'Halo Kak! 👋 Selamat datang di DinoyoCraft (Kampung Wisata Keramik Dinoyo, Malang).\n\nSaya ClayBot, siap membantu seputar:\n• Rekomendasi & cek harga/stok produk keramik\n• Info Workshop Keramik Dinoyo\n• Pembayaran Midtrans (QRIS / Virtual Account / e-Wallet) & pengemasan aman bergaransi\n• Bantuan & lacak pesanan (#DNC-XXXX)\n\nAda yang ingin Kakak tanyakan? 😊';
  }

  if (/(workshop|bengkel|belajar|kelas|wisata|jadwal|reservasi|bikin keramik)/i.test(lower)) {
    return 'Workshop Keramik Kampung Dinoyo tersedia untuk edukasi & wisata praktik membuat gerabah/keramik (±2 jam per sesi bersama pengrajin lokal Dinoyo, Malang).\n\nKakak bisa membuka menu Workshop di aplikasi untuk melihat paket aktivitas dan melakukan reservasi jadwal langsung dengan pengrajin ya! 🎨🏺';
  }

  if (/(kirim|ongkir|packing|pack|aman|pecah|retak|kayu|garansi|bubble)/i.test(lower)) {
    return 'Setiap keramik DinoyoCraft dikemas berlapis (triple bubble wrap, busa pelindung, kardus tebal) dan rangka kayu untuk pengiriman luar kota/pulau.\n\nKami juga menyediakan garansi ganti baru bila produk pecah atau retak saat diterima (cukup sertakan video unboxing utuh).';
  }

  if (/(pulih|pemulihan|terkunci|blokir|suspend|nonaktif|akun\s*hilang|tidak\s*bisa\s*login|kendala\s*akun|otp\s*tidak\s*masuk|hapus\s*akun|akun)/i.test(lower)) {
    if (/(lupa\s*(?:kata\s*)?sandi|lupa\s*password|reset\s*password)/i.test(lower)) {
      return 'Untuk mengatur ulang kata sandi (jika email akun masih aktif):\n1. Tekan "Lupa kata sandi?" pada halaman Login.\n2. Masukkan email yang terdaftar lalu cek kode OTP di email Anda.\n3. Masukkan kode OTP dan buat kata sandi baru minimal 8 karakter.\n\nJika email sudah tidak dapat diakses atau akun membutuhkan pemulihan manual, silakan kirim email ke Customer Service DinoyoCraft di csdinoyocraft@gmail.com dengan menyertakan:\n1. Nama lengkap sesuai akun\n2. Email terdaftar (dan ID Akun #DNC-XXXX bila ingat)\n3. Nomor HP / WhatsApp aktif\n4. Penjelasan singkat kendala akun\n5. Lampiran tangkapan layar kendala jika ada';
    }
    return 'Untuk pemulihan akun, akun terkunci/dinonaktifkan, atau kendala akses lainnya, tim Customer Service kami siap membantu secara langsung. Silakan kirim email ke csdinoyocraft@gmail.com (jam layanan 09.00-18.00 WIB) dengan subjek "Permohonan Pemulihan Akun DinoyoCraft" dan sertakan data berikut:\n\n1. Nama lengkap sesuai akun\n2. Email yang terdaftar di DinoyoCraft (dan ID Akun #DNC-XXXX bila ingat)\n3. Nomor HP / WhatsApp aktif\n4. Penjelasan singkat atau kronologi kendala akun Anda\n5. Lampiran tangkapan layar kendala atau bukti transaksi terakhir (jika ada)';
  }

  if (/(bayar|pembayaran|midtrans|qris|gopay|shopeepay|bca|bni|bri|mandiri|permata|transfer|va)/i.test(lower)) {
    return 'DinoyoCraft mendukung pembayaran resmi & otomatis via Midtrans: QRIS, Virtual Account (BCA, BNI, BRI, Mandiri, Permata), GoPay, dan ShopeePay. Status pesanan otomatis diperbarui setelah pembayaran berhasil.';
  }

  if (/(pesanan|order|lacak|resi|dikemas|dikirim|dnc)/i.test(lower)) {
    return 'Untuk melacak status pesanan, buka menu Profil -> Riwayat Pesanan pada aplikasi (kode pelanggan #DNC-XXXX atau kode toko ORD-...). Kakak juga bisa menekan tombol "Hubungi Penjual" pada detail pesanan atau "Chat dengan Customer Service Langsung" jika butuh pengecekan manual ya!';
  }

  if (roleContext === 'store_bot') {
    if (products.length > 0) {
      const storeLabel = products[0]?.store_name || 'toko kami';
      const storeList = products
        .slice(0, 8)
        .map(
          (p) =>
            `• ${p.name} (${p.category_name || 'Keramik'}) — Rp ${Number(p.price).toLocaleString('id-ID')} (Stok: ${p.stock})`
        )
        .join('\n');
      return `Halo Kak! Berikut daftar produk keramik yang tersedia di ${storeLabel}:\n\n${storeList}\n\nJika ada yang ingin ditanyakan soal varian, pesanan custom, atau negosiasi langsung dengan pemilik toko, silakan tekan tombol "Chat Penjual" di bawah ya!`;
    }
    return 'Halo Kak! Pesanmu sudah kami terima. Untuk cek ketersediaan stok terbaru atau pemesanan custom di toko kami, silakan tekan tombol "Chat Penjual" di bagian bawah agar langsung terhubung dengan pemilik toko ya!';
  }

  if (matchedProducts.length > 0) {
    const list = matchedProducts
      .slice(0, 4)
      .map(
        (p) =>
          `• ${p.name} (${p.store_name}) — Rp ${Number(p.price).toLocaleString('id-ID')} (Stok: ${p.stock})`
      )
      .join('\n');
    return `Halo Kak! Berikut produk keramik DinoyoCraft yang cocok dengan pencarianmu:\n\n${list}\n\nSetiap keramik dikirim dengan proteksi berlapis (triple bubble wrap & rangka kayu luar kota). Ingin info varian atau pesan langsung? Silakan tekan tombol "Chat dengan Customer Service Langsung" ya!`;
  }

  if (products.length > 0 || stores.length > 0) {
    const sampleProds = products
      .slice(0, 4)
      .map((p) => `• ${p.name} (${p.store_name}) — Rp ${Number(p.price).toLocaleString('id-ID')}`)
      .join('\n');
    return `Halo Kak! Berikut beberapa koleksi keramik aktif di DinoyoCraft:\n\n${sampleProds}\n\nKami mendukung pembayaran QRIS / Virtual Account Midtrans dan pengiriman aman berpelindung kayu. Untuk bantuan lebih lanjut, Kakak dapat menekan tombol "Chat dengan Customer Service Langsung" ya!`;
  }

  return 'Halo Kak! Saya ClayBot dari DinoyoCraft Malang. Kami menyediakan keramik handmade pengrajin Dinoyo dengan pengiriman berpelindung kayu dan pembayaran Midtrans (QRIS/Virtual Account). Jika butuh bantuan langsung dari tim kami, silakan pilih tombol Chat dengan Customer Service Langsung ya!';
}

// -------------------------------------------------------
// Controller: POST /api/ai/chat (ClayBot CS & Asisten Mitra)
// -------------------------------------------------------
export const chatWithClayBot = async (req: Request, res: Response): Promise<void> => {
  const startTime = Date.now();
  try {
    const {
      message,
      history = [],
      locale = 'id',
      role_context,
      store_name,
      store_user_id,
      product_name,
    } = req.body;
    const userMessage = String(message || '').trim();
    if (!userMessage) {
      sendBadRequest(res, 'Pesan tidak boleh kosong.');
      return;
    }

    const lang: 'id' | 'en' = locale === 'en' ? 'en' : 'id';

    // 1. Cek guardrail platform KETAT sebelum menyentuh LLM atau fallback katalog
    //    Termasuk deteksi serangan sandwich (misal: selipkan copas code error di antara pertanyaan vas keramik)
    const guardrail = evaluatePlatformGuardrail(userMessage, lang);
    if (guardrail.blocked) {
      res.locals['logCategory'] = 'ai';
      res.locals['logEventName'] = 'ai.claybot.guardrail_blocked';
      res.locals['logMessage'] = `Guardrail memblokir input (${guardrail.reason || 'policy'})`;
      sendSuccess(
        res,
        {
          reply: guardrail.reply,
          model: 'guardrail-policy',
          blocked: true,
          reason: guardrail.reason,
        },
        'Balasan kebijakan platform DinoyoCraft.'
      );
      return;
    }

    const authRole = res.locals['role'] as string | undefined;
    const authUserId = res.locals['userId'] as number | undefined;
    const resolvedRoleContext: AiRoleContext =
      role_context === 'mitra' || role_context === 'store_bot' || role_context === 'customer'
        ? role_context
        : authRole === 'mitra'
          ? 'mitra'
          : 'customer';

    // 2. Muat konfigurasi AI aktif dari database (terdekripsi otomatis)
    const settings = await getEffectiveAiSettings();
    if (!settings.isAutoReplyActive) {
      const pausedReply =
        lang === 'en'
          ? 'DinoyoCraft AI auto-reply is currently paused by the administrator. Please connect directly via "Chat dengan Customer Service Langsung" or contact the seller directly.'
          : 'Maaf Kak, layanan balas otomatis Asisten AI sedang dinonaktifkan sementara oleh Admin. Silakan hubungi tim kami langsung melalui tombol "Chat dengan Customer Service Langsung" atau chat penjual secara langsung ya! 🙏';
      sendSuccess(
        res,
        {
          reply: pausedReply,
          model: 'auto-reply-disabled',
          disabled: true,
        },
        'Auto-reply AI sedang nonaktif.'
      );
      return;
    }

    // 3. Ambil ringkasan katalog produk & toko pengrajin nyata dari database
    //    KHUSUS mode 'store_bot': isolasi KETAT agar hanya memuat produk milik toko bersangkutan saja.
    let prodRows: any[] = [];
    let storeRows: any[] = [];
    let mitraContextSummary = '';
    let storeCatalogSummary = '';
    let matchedStoreInfo: any = null;

    try {
      if (resolvedRoleContext === 'store_bot') {
        const numericStoreUserId = Number(store_user_id);
        const cleanStoreName = String(store_name || '').trim();

        if (Number.isFinite(numericStoreUserId) && numericStoreUserId > 0) {
          const [sRows]: any = await pool.query(
            `SELECT mp.id, mp.user_id, mp.store_name, mp.workshop_address, mp.description, mp.rating
             FROM mitra_profiles mp
             WHERE mp.user_id = ?
             LIMIT 1`,
            [numericStoreUserId]
          );
          matchedStoreInfo = sRows?.[0] || null;
        }

        if (!matchedStoreInfo && cleanStoreName) {
          const [sRows]: any = await pool.query(
            `SELECT mp.id, mp.user_id, mp.store_name, mp.workshop_address, mp.description, mp.rating
             FROM mitra_profiles mp
             JOIN users u ON u.id = mp.user_id
             WHERE LOWER(TRIM(mp.store_name)) = LOWER(?) OR LOWER(TRIM(u.name)) = LOWER(?)
             LIMIT 1`,
            [cleanStoreName, cleanStoreName]
          );
          matchedStoreInfo = sRows?.[0] || null;
        }

        if (matchedStoreInfo) {
          const [storeProds]: any = await pool.query(
            `SELECT p.id, p.name, p.price, p.stock, p.description, c.name AS category_name, ? AS store_name
             FROM products p
             LEFT JOIN categories c ON p.category_id = c.id
             WHERE p.mitra_id = ? AND p.is_deleted = 0
             ORDER BY p.id DESC
             LIMIT 25`,
            [matchedStoreInfo.store_name, matchedStoreInfo.id]
          );
          prodRows = Array.isArray(storeProds) ? storeProds : [];
          storeRows = [matchedStoreInfo];

          storeCatalogSummary =
            `TOKO YANG SEDANG KAMU WAKILI SAAT INI:\n` +
            `- Nama Toko: ${matchedStoreInfo.store_name}\n` +
            `- Lokasi Workshop: ${matchedStoreInfo.workshop_address || 'Kampung Keramik Dinoyo, Malang'}\n` +
            (matchedStoreInfo.description ? `- Profil Singkat: ${matchedStoreInfo.description}\n` : '') +
            `\nDAFTAR PRODUK RESMI HANYA MILIK TOKO "${matchedStoreInfo.store_name}":\n` +
            (prodRows.length > 0
              ? prodRows
                .map(
                  (p: any, idx: number) =>
                    `${idx + 1}. ${p.name} (${p.category_name || 'Keramik'}) — Rp ${Number(p.price).toLocaleString('id-ID')} | Stok: ${p.stock}`
                )
                .join('\n')
              : '(Toko ini belum memiliki daftar produk yang dipajang di katalog saat ini. Jangan menyebut produk dari toko lain; arahkan pelanggan menekan tombol "Chat Penjual" untuk menanyakan ketersediaan langsung.)');
        } else {
          storeCatalogSummary =
            `TOKO YANG SEDANG KAMU WAKILI: ${cleanStoreName || 'Toko Mitra DinoyoCraft'}\n` +
            `(Data katalog produk khusus toko ini tidak ditemukan atau kosong. Jangan pernah menyebut produk milik toko lain; arahkan pelanggan menekan tombol "Chat Penjual" untuk menanyakan detail stok kepada pemilik toko.)`;
        }
      } else {
        const [prods]: any = await pool.query(
          `SELECT p.id, p.name, p.price, p.stock, c.name AS category_name, m.store_name
           FROM products p
           JOIN mitra_profiles m ON p.mitra_id = m.id
           LEFT JOIN categories c ON p.category_id = c.id
           WHERE p.is_deleted = 0 AND m.is_active = 1
           ORDER BY p.id DESC
           LIMIT 25`
        );
        prodRows = Array.isArray(prods) ? prods : [];

        const [stores]: any = await pool.query(
          `SELECT store_name, workshop_address, rating
           FROM mitra_profiles
           WHERE is_active = 1
           ORDER BY rating DESC, id ASC
           LIMIT 12`
        );
        storeRows = Array.isArray(stores) ? stores : [];

        if (resolvedRoleContext === 'mitra' && authUserId) {
          const [myMitraRows]: any = await pool.query(
            `SELECT id, store_name, workshop_address, is_verified
             FROM mitra_profiles
             WHERE user_id = ?
             LIMIT 1`,
            [authUserId]
          );
          const myMitra = myMitraRows?.[0];
          if (myMitra) {
            const [myProds]: any = await pool.query(
              `SELECT name, price, stock FROM products WHERE mitra_id = ? AND is_deleted = 0 ORDER BY id DESC LIMIT 10`,
              [myMitra.id]
            );
            mitraContextSummary =
              `\nPROFIL TOKO MITRA YANG SEDANG BERTANYA:\n` +
              `- Nama Toko: ${myMitra.store_name}\n` +
              `- Alamat Workshop: ${myMitra.workshop_address || 'Dinoyo, Malang'}\n` +
              `- Status Verifikasi: ${Number(myMitra.is_verified) === 1 ? 'Terverifikasi' : 'Menunggu Verifikasi Admin'}\n` +
              (Array.isArray(myProds) && myProds.length > 0
                ? `- Produk Toko Ini:\n${myProds
                  .map((p: any) => `  • ${p.name} — Rp ${Number(p.price).toLocaleString('id-ID')} (Stok: ${p.stock})`)
                  .join('\n')}`
                : '- Belum ada produk aktif di katalog toko ini.');
          }
        }
      }
    } catch {
      // Abaikan jika gagal query katalog
    }

    let catalogSummary = '';
    if (resolvedRoleContext === 'store_bot') {
      catalogSummary = storeCatalogSummary;
    } else {
      if (prodRows.length > 0) {
        catalogSummary +=
          'PRODUK AKTIF DI KATALOG DINOYOCRAFT:\n' +
          prodRows
            .map(
              (p: any) =>
                `• ${p.name} (${p.category_name || 'Keramik'}) oleh ${p.store_name} — Rp ${Number(p.price).toLocaleString('id-ID')} (Stok: ${p.stock})`
            )
            .join('\n');
      }
      if (storeRows.length > 0) {
        catalogSummary +=
          '\n\nTOKO / MITRA PENGRAJIN DINOYOCRAFT:\n' +
          storeRows
            .map((s: any) => `• ${s.store_name} (${s.workshop_address || 'Dinoyo, Malang'})`)
            .join('\n');
      }
    }

    const storeBotExtra =
      resolvedRoleContext === 'store_bot' && product_name
        ? `\nPRODUK YANG SEDANG DITANYAKAN PELANGGAN DI CHAT: ${product_name}`
        : '';

    const langInstruction =
      lang === 'en'
        ? 'LANGUAGE & STYLE: Reply warmly, clearly, and concisely in clean plain English (NO Markdown **, *, #, or ` symbols; max 160 words).'
        : 'BAHASA & FORMAT: Jawab dengan ramah, sopan, rapi, dan terstruktur dalam Bahasa Indonesia (teks polos TANPA simbol Markdown **, *, #, _, atau `; maksimal 180 kata).';

    const extraContext = [
      langInstruction,
      storeBotExtra,
      mitraContextSummary,
      catalogSummary ? `\n${catalogSummary}` : '',
    ]
      .filter(Boolean)
      .join('\n');

    const guardedSystemPrompt = buildGuardedSystemPrompt(
      settings.systemPrompt,
      extraContext,
      resolvedRoleContext
    );

    const sanitizedHistory: AiChatHistoryItem[] = Array.isArray(history)
      ? history.slice(-8).map((h: any) => ({
        role: h.role === 'user' ? 'user' : 'assistant',
        content: sanitizeChatTextForAi(String(h.content || '')),
      }))
      : [];

    const sanitizedMessage = sanitizeChatTextForAi(userMessage);

    // 4. Panggil LLM multi-provider sesuai konfigurasi Admin
    if (settings.apiKey) {
      try {
        const result = await generateAiCompletion({
          apiKey: settings.apiKey,
          provider: settings.provider,
          model: settings.modelName,
          systemPrompt: guardedSystemPrompt,
          history: sanitizedHistory,
          userMessage: sanitizedMessage,
          temperature: 0.4,
          maxTokens: 700,
        });

        const formattedReply = cleanAiChatOutput(result.text);
        if (formattedReply) {
          res.locals['logCategory'] = 'ai';
          res.locals['logService'] = result.provider;
          res.locals['logEventName'] = 'ai.claybot.completed';
          res.locals['logMessage'] = `Request AI ClayBot (${resolvedRoleContext}) selesai via ${result.provider}/${result.model} (${Date.now() - startTime} ms)`;
          sendSuccess(
            res,
            {
              reply: formattedReply,
              provider: result.provider,
              model: result.model,
            },
            'Balasan ClayBot berhasil dibuat.'
          );
          return;
        }
      } catch (aiErr: any) {
        console.warn(
          `⚠️ [ClayBot] Gagal memanggil ${settings.providerLabel} (${settings.modelName}):`,
          aiErr?.message || aiErr
        );
      }
    }

    // 5. Fallback kontekstual berbasis katalog nyata (jika API key belum diisi atau semua model gagal)
    res.locals['logCategory'] = 'ai';
    res.locals['logEventName'] = 'ai.claybot.fallback';
    res.locals['logMessage'] = `ClayBot menggunakan catalog-assistant fallback (provider: ${settings.providerLabel}, model: ${settings.modelName})`;
    const fallbackReply = cleanAiChatOutput(
      buildCatalogFallbackReply(
        userMessage,
        lang,
        resolvedRoleContext,
        prodRows,
        storeRows
      )
    );

    sendSuccess(
      res,
      { reply: fallbackReply, model: 'catalog-assistant' },
      'Balasan ClayBot berhasil dibuat.'
    );
  } catch (err: unknown) {
    res.locals['loggedError'] = err instanceof Error ? err : new Error(String(err));
    console.error('❌ [chatWithClayBot] Error:', err);
    sendError(res, 'Gagal memproses pesan ClayBot.', 500, String(err));
  }
};
