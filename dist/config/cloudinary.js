"use strict";
// ============================================================
//  src/config/cloudinary.ts
//  Konfigurasi Cloudinary SDK v2 untuk penyimpanan media eksternal
//  Mendukung CLOUDINARY_URL atau kombinasi CLOUD_NAME/API_KEY/API_SECRET
// ============================================================
Object.defineProperty(exports, "__esModule", { value: true });
exports.deleteFromCloudinary = exports.uploadStreamToCloudinary = exports.CLOUDINARY_BASE_FOLDER = exports.isCloudinaryConfigured = void 0;
require("dotenv/config");
const cloudinary_1 = require("cloudinary");
const cloudinaryUrl = (process.env['CLOUDINARY_URL'] || '').trim();
const cloudName = (process.env['CLOUDINARY_CLOUD_NAME'] || '').trim();
const apiKey = (process.env['CLOUDINARY_API_KEY'] || '').trim();
const apiSecret = (process.env['CLOUDINARY_API_SECRET'] || '').trim();
const hasUrl = Boolean(cloudinaryUrl && cloudinaryUrl.startsWith('cloudinary://'));
const hasTriple = Boolean(cloudName &&
    apiKey &&
    apiSecret &&
    !cloudName.startsWith('your_') &&
    !apiKey.startsWith('your_') &&
    !apiSecret.startsWith('your_'));
exports.isCloudinaryConfigured = hasUrl || hasTriple;
exports.CLOUDINARY_BASE_FOLDER = (process.env['CLOUDINARY_FOLDER'] || 'dinoyocraft').trim().replace(/^\/+|\/+$/g, '') ||
    'dinoyocraft';
if (hasTriple) {
    cloudinary_1.v2.config({
        cloud_name: cloudName,
        api_key: apiKey,
        api_secret: apiSecret,
        secure: true,
    });
}
else if (hasUrl) {
    // SDK otomatis membaca process.env.CLOUDINARY_URL, cukup pastikan secure: true
    cloudinary_1.v2.config({ secure: true });
}
if (exports.isCloudinaryConfigured) {
    console.log(`☁️  Cloudinary storage aktif (folder: ${exports.CLOUDINARY_BASE_FOLDER})`);
}
else {
    console.warn('⚠️  Cloudinary belum dikonfigurasi di .env — upload menggunakan penyimpanan lokal (uploads/).');
}
/**
 * Upload readable stream langsung ke Cloudinary (tanpa menulis ke disk lokal).
 */
const uploadStreamToCloudinary = (stream, options = {}) => {
    return new Promise((resolve, reject) => {
        const uploadStream = cloudinary_1.v2.uploader.upload_stream({
            resource_type: 'auto',
            unique_filename: true,
            overwrite: false,
            ...options,
        }, (error, result) => {
            if (error || !result) {
                reject(error || new Error('Upload ke Cloudinary gagal tanpa respons.'));
                return;
            }
            resolve(result);
        });
        stream.on('error', (err) => reject(err));
        stream.pipe(uploadStream);
    });
};
exports.uploadStreamToCloudinary = uploadStreamToCloudinary;
/**
 * Hapus aset dari Cloudinary berdasarkan public_id (opsional untuk cleanup).
 */
const deleteFromCloudinary = async (publicId, resourceType = 'image') => {
    if (!exports.isCloudinaryConfigured || !publicId)
        return;
    try {
        await cloudinary_1.v2.uploader.destroy(publicId, { resource_type: resourceType });
    }
    catch (err) {
        console.warn(`⚠️  Gagal menghapus aset Cloudinary (${publicId}):`, err);
    }
};
exports.deleteFromCloudinary = deleteFromCloudinary;
exports.default = cloudinary_1.v2;
//# sourceMappingURL=cloudinary.js.map