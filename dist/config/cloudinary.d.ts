import 'dotenv/config';
import { v2 as cloudinary, UploadApiOptions, UploadApiResponse } from 'cloudinary';
import { Readable } from 'stream';
export declare const isCloudinaryConfigured: boolean;
export declare const CLOUDINARY_BASE_FOLDER: string;
/**
 * Upload readable stream langsung ke Cloudinary (tanpa menulis ke disk lokal).
 */
export declare const uploadStreamToCloudinary: (stream: Readable, options?: UploadApiOptions) => Promise<UploadApiResponse>;
/**
 * Hapus aset dari Cloudinary berdasarkan public_id (opsional untuk cleanup).
 */
export declare const deleteFromCloudinary: (publicId: string, resourceType?: 'image' | 'video' | 'raw') => Promise<void>;
export default cloudinary;
//# sourceMappingURL=cloudinary.d.ts.map