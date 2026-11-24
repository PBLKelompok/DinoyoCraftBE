import { initializeApp, cert, getApps, ServiceAccount } from 'firebase-admin/app';
import fs from 'fs';
import path from 'path';

let isFirebaseInitialized = false;

const loadServiceAccount = (): { credential: ServiceAccount; source: string } | null => {
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
    } catch (err) {
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
  const serviceAccountPath =
    process.env['FIREBASE_SERVICE_ACCOUNT_PATH'] || './src/config/firebase-service-account.json';
  const resolvedPath = path.resolve(process.cwd(), serviceAccountPath);
  if (fs.existsSync(resolvedPath)) {
    try {
      const parsed = JSON.parse(fs.readFileSync(resolvedPath, 'utf8'));
      return { credential: parsed, source: `file ${serviceAccountPath}` };
    } catch (err) {
      console.warn('⚠️ Gagal membaca Firebase service account file:', err);
    }
  } else {
    console.warn(
      '⚠️ Firebase Admin belum dikonfigurasi (file lokal tidak ada & FIREBASE_SERVICE_ACCOUNT_JSON kosong).'
    );
  }

  return null;
};

const loaded = loadServiceAccount();
if (loaded) {
  try {
    if (getApps().length === 0) {
      initializeApp({
        credential: cert(loaded.credential),
      });
    }
    isFirebaseInitialized = true;
    console.log(`✅ Firebase Admin SDK berhasil diinisialisasi (${loaded.source}).`);
  } catch (err) {
    console.warn('⚠️ Gagal menginisialisasi Firebase Admin SDK:', err);
  }
}

export { isFirebaseInitialized };
