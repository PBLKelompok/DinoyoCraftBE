// ============================================================
//  src/config/cloudinary.ts
//  Konfigurasi Cloudinary SDK v2 untuk penyimpanan media eksternal
//  Mendukung CLOUDINARY_URL atau kombinasi CLOUD_NAME/API_KEY/API_SECRET
// ============================================================

import 'dotenv/config';
import { v2 as cloudinary, UploadApiOptions, UploadApiResponse } from 'cloudinary';
import { Readable } from 'stream';

const cloudinaryUrl = (process.env['CLOUDINARY_URL'] || '').trim();
const cloudName = (process.env['CLOUDINARY_CLOUD_NAME'] || '').trim();
const apiKey = (process.env['CLOUDINARY_API_KEY'] || '').trim();
const apiSecret = (process.env['CLOUDINARY_API_SECRET'] || '').trim();

const hasUrl = Boolean(cloudinaryUrl && cloudinaryUrl.startsWith('cloudinary://'));
const hasTriple = Boolean(
  cloudName &&
    apiKey &&
    apiSecret &&
    !cloudName.startsWith('your_') &&
    !apiKey.startsWith('your_') &&
    !apiSecret.startsWith('your_')
);

export const isCloudinaryConfigured = hasUrl || hasTriple;
export const CLOUDINARY_BASE_FOLDER =
  (process.env['CLOUDINARY_FOLDER'] || 'dinoyocraft').trim().replace(/^\/+|\/+$/g, '') ||
  'dinoyocraft';

if (hasTriple) {
  cloudinary.config({
    cloud_name: cloudName,
    api_key: apiKey,
    api_secret: apiSecret,
    secure: true,
  });
} else if (hasUrl) {
  // SDK otomatis membaca process.env.CLOUDINARY_URL, cukup pastikan secure: true
  cloudinary.config({ secure: true });
}

if (isCloudinaryConfigured) {
  console.log(`☁️  Cloudinary storage aktif (folder: ${CLOUDINARY_BASE_FOLDER})`);
} else {
  console.warn(
    '⚠️  Cloudinary belum dikonfigurasi di .env — upload menggunakan penyimpanan lokal (uploads/).'
  );
}

/**
 * Upload readable stream langsung ke Cloudinary (tanpa menulis ke disk lokal).
 */
export const uploadStreamToCloudinary = (
  stream: Readable,
  options: UploadApiOptions = {}
): Promise<UploadApiResponse> => {
  return new Promise((resolve, reject) => {
    const uploadStream = cloudinary.uploader.upload_stream(
      {
        resource_type: 'auto',
        unique_filename: true,
        overwrite: false,
        ...options,
      },
      (error, result) => {
        if (error || !result) {
          reject(error || new Error('Upload ke Cloudinary gagal tanpa respons.'));
          return;
        }
        resolve(result);
      }
    );

    stream.on('error', (err) => reject(err));
    stream.pipe(uploadStream);
  });
};

/**
 * Hapus aset dari Cloudinary berdasarkan public_id (opsional untuk cleanup).
 */
export const deleteFromCloudinary = async (
  publicId: string,
  resourceType: 'image' | 'video' | 'raw' = 'image'
): Promise<void> => {
  if (!isCloudinaryConfigured || !publicId) return;
  try {
    await cloudinary.uploader.destroy(publicId, { resource_type: resourceType });
  } catch (err) {
    console.warn(`⚠️  Gagal menghapus aset Cloudinary (${publicId}):`, err);
  }
};

export default cloudinary;
