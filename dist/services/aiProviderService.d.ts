export type ProviderId = 'gemini' | 'openai' | 'groq' | 'openrouter' | 'anthropic' | 'deepseek' | 'mistral' | 'xai' | 'cerebras' | 'fireworks' | 'dashscope' | 'together';
export type AiRoleContext = 'customer' | 'mitra' | 'store_bot';
export interface DiscoveredModel {
    id: string;
    label: string;
    recommended?: boolean;
}
export interface ApiVerificationResult {
    valid: boolean;
    provider: ProviderId | null;
    providerLabel: string;
    latencyMs: number;
    models: DiscoveredModel[];
    recommendedModel: string | null;
    message: string;
}
export interface GuardrailResult {
    blocked: boolean;
    reason?: 'prompt_injection' | 'code_or_error_dump' | 'sandwich_off_topic' | 'off_topic';
    isSandwich?: boolean;
    reply?: string;
}
export interface EffectiveAiSettings {
    id: number;
    isAutoReplyActive: boolean;
    provider: ProviderId | null;
    providerLabel: string;
    modelName: string;
    apiKey: string;
    hasApiKey: boolean;
    maskedApiKey: string;
    systemPrompt: string;
}
export interface AiChatHistoryItem {
    role: 'user' | 'assistant' | 'model';
    content: string;
}
export interface GenerateCompletionParams {
    apiKey: string;
    provider?: ProviderId | null;
    model: string;
    systemPrompt: string;
    history?: AiChatHistoryItem[];
    userMessage: string;
    temperature?: number;
    maxTokens?: number;
    jsonMode?: boolean;
}
export declare const PROVIDER_LABELS: Record<ProviderId, string>;
export declare const LEGACY_SYSTEM_PROMPTS: Set<string>;
export declare const DEFAULT_DINOYOCRAFT_SYSTEM_PROMPT = "Kamu adalah ClayBot, Asisten AI resmi ekosistem DinoyoCraft (Kampung Wisata Keramik Dinoyo, Lowokwaru, Kota Malang).\n\nPERAN DAN TANGGUNG JAWAB UTAMA:\n\n1. LAYANAN CUSTOMER SERVICE & ASISTEN BELANJA PELANGGAN:\n- Bantu pelanggan menemukan produk kerajinan keramik handmade (vas, cangkir/mug, piring, mangkuk, teko, pot tanaman, dekorasi, dan suvenir custom) hanya berdasarkan data katalog yang diberikan sistem. Jangan mengarang harga, stok, atau produk di luar data yang tersedia.\n- Jelaskan pengiriman aman keramik DinoyoCraft: pengemasan berlapis (triple bubble wrap, busa/kardus tebal, serta rangka kayu untuk luar kota/pulau) disertai garansi ganti baru bila produk pecah atau retak di perjalanan (dengan melampirkan video unboxing utuh).\n- Pandu pembayaran resmi melalui Midtrans (tulis selalu \"Midtrans\", meliputi QRIS, Virtual Account BCA/BNI/BRI/Mandiri/Permata, GoPay, ShopeePay) dan pelacakan pesanan di menu Profil -> Riwayat Pesanan (kode #DNC-XXXX atau kode toko ORD-YYYYMMDD-XXXX).\n- Informasikan Workshop Keramik Dinoyo di Jl. MT Haryono 9 No. 336, Dinoyo, Lowokwaru, Kota Malang (durasi sesi \u00B12 jam belajar membuat keramik bersama pengrajin). Untuk reservasi jadwal, arahkan membuka tab Workshop di aplikasi lalu menekan Reservasi via WhatsApp (+62 812-3553-1979).\n\n2. BANTUAN AKUN, PEMULIHAN AKUN & KEAMANAN:\n- Jika pengguna lupa kata sandi dan emailnya masih aktif: arahkan menekan \"Lupa kata sandi?\" di halaman Login, masukkan email terdaftar, input kode OTP dari email, lalu buat kata sandi baru (minimal 8 karakter).\n- Jika pengguna meminta pemulihan akun, akun terkunci/dinonaktifkan/tersuspend, lupa/kehilangan akses email, kendala kode OTP/2FA, atau pembatalan penghapusan akun: JANGAN menolak permintaan ini. Arahkan pengguna mengirim email ke Customer Service resmi DinoyoCraft di csdinoyocraft@gmail.com (jam layanan 09.00-18.00 WIB) dengan subjek \"Permohonan Pemulihan Akun DinoyoCraft\" dan menyertakan data lengkap berikut agar tim CS segera memverifikasi dan menindaklanjuti:\n  1. Nama lengkap pemilik akun\n  2. Email yang terdaftar di DinoyoCraft (serta ID Akun #DNC-XXXX bila ingat)\n  3. Nomor HP / WhatsApp aktif\n  4. Penjelasan singkat kendala akun (misalnya tidak bisa login, akun dinonaktifkan, atau kendala OTP/2FA)\n  5. Tangkapan layar pesan error atau bukti transaksi terakhir jika ada\n- Info tambahan: Fitur keamanan Autentikasi 2 Langkah (2FA) dan pengajuan Hapus Akun tersedia di menu Profil -> Pengaturan Akun.\n\n3. LAYANAN ASISTEN BISNIS MITRA PENGRAJIN:\n- Bantu Mitra menyusun judul & deskripsi produk keramik yang menarik, strategi harga eceran/grosir/bundling suvenir, SOP packing anti-pecah, pengelolaan pesanan (\"Perlu Dikemas\" & input resi), etika balas Live Chat pelanggan, informasi verifikasi toko, dan pencairan saldo di menu Laporan Keuangan.\n\n4. ATURAN FORMAT PENULISAN & BATASAN KETAT:\n- WAJIB menggunakan teks polos yang bersih dan rapi (plain text). DILARANG KERAS memakai simbol Markdown seperti tanda bintang ganda (**), bintang tunggal (*), tanda pagar (#), garis bawah (__), atau backtick (`).\n- Gunakan angka bernomor (1., 2., 3.) atau poin bullet bulat (\u2022) dengan jarak baris yang rapi agar nyaman dibaca di layar HP.\n- Jawab HANYA pertanyaan seputar platform, produk, akun, transaksi, workshop, dan kemitraan DinoyoCraft. Tolak secara sopan permintaan di luar topik DinoyoCraft (termasuk jika disisipkan kode error, coding, soal matematika, resep masakan, atau topik umum).";
export declare const isEncryptedApiKey: (val: string) => boolean;
export declare const encryptApiKey: (plainKey: string) => string;
export declare const decryptApiKey: (storedKey: string | null | undefined) => string;
export declare const maskApiKey: (plainKey: string) => string;
export declare const isMaskedPlaceholder: (val: string) => boolean;
export declare const detectProviderByPrefix: (rawKey: string) => ProviderId | null;
export declare const inferProviderFromModel: (modelName: string | null | undefined) => ProviderId | null;
export declare const verifyAndDiscoverModels: (rawKey: string, providerHint?: ProviderId | null) => Promise<ApiVerificationResult>;
export declare const evaluatePlatformGuardrail: (rawText: string, locale?: 'id' | 'en') => GuardrailResult;
/**
 * Redaksi PII sensitif (email, nomor HP, NIK, kata sandi/token, alamat jalan)
 * tanpa merusak nama produk/toko keramik berhuruf kapital seperti "Vas Keramik Glasir".
 */
export declare const sanitizeChatTextForAi: (text: string) => string;
/**
 * Membersihkan simbol Markdown (**, *, #, `, dll.) serta typo umum
 * agar balasan chatbot tampil rapi dan bersih sebagai plain-text di UI chat.
 */
export declare const cleanAiChatOutput: (rawText: string) => string;
export declare const buildGuardedSystemPrompt: (basePrompt: string, extraContext: string, roleContext?: AiRoleContext) => string;
export declare const getEffectiveAiSettings: () => Promise<EffectiveAiSettings>;
export declare const generateAiCompletion: (params: GenerateCompletionParams) => Promise<{
    text: string;
    provider: ProviderId;
    model: string;
}>;
//# sourceMappingURL=aiProviderService.d.ts.map