"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.isFirebaseInitialized = void 0;
const app_1 = require("firebase-admin/app");
const fs_1 = __importDefault(require("fs"));
const path_1 = __importDefault(require("path"));
let isFirebaseInitialized = false;
exports.isFirebaseInitialized = isFirebaseInitialized;
const loadServiceAccount = () => {
    // 1. Prioritas utama (untuk Zerops / Cloud): JSON mentah atau Base64 dari env
    const rawJsonEnv = (process.env['FIREBASE_SERVICE_ACCOUNT_JSON'] || '').trim();
    if (rawJsonEnv) {
        try {
            const jsonStr = rawJsonEnv.startsWith('{')
                ? rawJsonEnv
                : Buffer.from(rawJsonEnv, 'base64').toString('utf8');
            const parsed = JSON.parse(jsonStr);
            if (parsed.private_key && typeof parsed.private_key === 'string') {
                parsed.private_key = parsed.private_key.replace(/\\n/g, '\n');
            }
            return { credential: parsed, source: 'env FIREBASE_SERVICE_ACCOUNT_JSON' };
        }
        catch (err) {
            console.warn('⚠️ Gagal mem-parsing FIREBASE_SERVICE_ACCOUNT_JSON:', err);
        }
    }
    // 2. Alternatif env terpisah (project_id + client_email + private_key)
    const projectId = (process.env['FIREBASE_PROJECT_ID'] || '').trim();
    const clientEmail = (process.env['FIREBASE_CLIENT_EMAIL'] || '').trim();
    const privateKey = (process.env['FIREBASE_PRIVATE_KEY'] || '').trim();
    if (projectId && clientEmail && privateKey) {
        return {
            credential: {
                projectId,
                clientEmail,
                privateKey: privateKey.replace(/\\n/g, '\n'),
            },
            source: 'env FIREBASE_PROJECT_ID/CLIENT_EMAIL/PRIVATE_KEY',
        };
    }
    // 3. Fallback file lokal (development)
    const serviceAccountPath = process.env['FIREBASE_SERVICE_ACCOUNT_PATH'] || './src/config/firebase-service-account.json';
    const resolvedPath = path_1.default.resolve(process.cwd(), serviceAccountPath);
    if (fs_1.default.existsSync(resolvedPath)) {
        try {
            const parsed = JSON.parse(fs_1.default.readFileSync(resolvedPath, 'utf8'));
            return { credential: parsed, source: `file ${serviceAccountPath}` };
        }
        catch (err) {
            console.warn('⚠️ Gagal membaca Firebase service account file:', err);
        }
    }
    else {
        console.warn('⚠️ Firebase Admin belum dikonfigurasi (file lokal tidak ada & FIREBASE_SERVICE_ACCOUNT_JSON kosong).');
    }
    return null;
};
const loaded = loadServiceAccount();
if (loaded) {
    try {
        if ((0, app_1.getApps)().length === 0) {
            (0, app_1.initializeApp)({
                credential: (0, app_1.cert)(loaded.credential),
            });
        }
        exports.isFirebaseInitialized = isFirebaseInitialized = true;
        console.log(`✅ Firebase Admin SDK berhasil diinisialisasi (${loaded.source}).`);
    }
    catch (err) {
        console.warn('⚠️ Gagal menginisialisasi Firebase Admin SDK:', err);
    }
}
//# sourceMappingURL=firebase.js.map