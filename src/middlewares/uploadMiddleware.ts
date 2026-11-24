import multer from 'multer';
import type { Request } from 'express';
import path from 'path';
import fs from 'fs';
import {
  CLOUDINARY_BASE_FOLDER,
  deleteFromCloudinary,
  isCloudinaryConfigured,
  uploadStreamToCloudinary,
} from '../config/cloudinary.js';

const MAX_UPLOAD_SIZE_BYTES = Number(process.env['UPLOAD_MAX_FILE_SIZE_MB'] || 10) * 1024 * 1024;

/**
 * Tentukan subfolder Cloudinary berdasarkan fieldname & endpoint.
 */
const resolveCloudinarySubfolder = (req: Request, fieldname: string): string => {
  const url = `${req.baseUrl || ''}${req.path || ''}`.toLowerCase();
  if (fieldname === 'ktp_file' || fieldname === 'nib_file') {
    return `${CLOUDINARY_BASE_FOLDER}/mitra-docs`;
  }
  if (fieldname === 'avatar' || fieldname === 'banner') {
    return `${CLOUDINARY_BASE_FOLDER}/profiles`;
  }
  if (fieldname === 'product_images' || fieldname === 'sample_product_images') {
    return `${CLOUDINARY_BASE_FOLDER}/products`;
  }
  if (url.includes('/chat')) {
    return `${CLOUDINARY_BASE_FOLDER}/chat`;
  }
  if (url.includes('/review')) {
    return `${CLOUDINARY_BASE_FOLDER}/reviews`;
  }
  if (url.includes('/product') || url.includes('/mitra')) {
    return `${CLOUDINARY_BASE_FOLDER}/products`;
  }
  return `${CLOUDINARY_BASE_FOLDER}/uploads`;
};

/**
 * Custom Multer StorageEngine yang streaming langsung ke Cloudinary
 * (zero local disk write — aman untuk container ephemeral seperti Zerops).
 */
class CloudinaryStorageEngine implements multer.StorageEngine {
  _handleFile(
    req: Request,
    file: Express.Multer.File,
    cb: (error?: any, info?: Partial<Express.Multer.File>) => void
  ): void {
    const folder = resolveCloudinarySubfolder(req, file.fieldname);
    const parsedName = path.parse(file.originalname || 'file').name;
    const safeSlug = parsedName
      .toLowerCase()
      .replace(/[^a-z0-9-_]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 40);
    const publicId = `${Date.now()}-${Math.round(Math.random() * 1e6)}${safeSlug ? `-${safeSlug}` : ''}`;

    uploadStreamToCloudinary(file.stream, {
      folder,
      public_id: publicId,
      resource_type: 'auto',
    })
      .then((result) => {
        cb(null, {
          path: result.secure_url,
          filename: result.public_id,
          size: result.bytes,
        });
      })
      .catch((err) => {
        cb(err);
      });
  }

  _removeFile(
    _req: Request,
    file: Express.Multer.File,
    cb: (error: Error | null) => void
  ): void {
    if (file.filename) {
      deleteFromCloudinary(file.filename)
        .then(() => cb(null))
        .catch(() => cb(null));
      return;
    }
    cb(null);
  }
}

// Fallback local DiskStorage bila Cloudinary belum dikonfigurasi di .env lokal
const createLocalDiskStorage = (): multer.StorageEngine => {
  const targetFolder = path.join(process.cwd(), 'uploads');
  if (!fs.existsSync(targetFolder)) {
    fs.mkdirSync(targetFolder, { recursive: true });
  }
  return multer.diskStorage({
    destination: (_req, _file, cb) => {
      cb(null, targetFolder);
    },
    filename: (_req, file, cb) => {
      const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1e9);
      cb(null, uniqueSuffix + path.extname(file.originalname));
    },
  });
};

const storage: multer.StorageEngine = isCloudinaryConfigured
  ? new CloudinaryStorageEngine()
  : createLocalDiskStorage();

const multerLimits: multer.Options['limits'] = {
  fileSize: MAX_UPLOAD_SIZE_BYTES,
};

/**
 * Ambil URL publik final dari file yang diupload oleh Multer:
 * - Jika Cloudinary aktif: `file.path` berisi `https://res.cloudinary.com/...`
 * - Jika fallback lokal: `/uploads/<filename>`
 */
export const getUploadedFileUrl = (
  file?: Partial<Express.Multer.File> | null
): string | null => {
  if (!file) return null;
  if (typeof file.path === 'string' && /^https?:\/\//i.test(file.path)) {
    return file.path;
  }
  if (typeof file.filename === 'string' && file.filename.trim()) {
    return `/uploads/${file.filename.trim()}`;
  }
  return null;
};

// Kita gunakan .fields() karena ada beberapa jenis file yang berbeda
export const uploadMitraDocs = multer({ storage, limits: multerLimits }).fields([
  { name: 'ktp_file', maxCount: 1 },
  { name: 'nib_file', maxCount: 1 },
  { name: 'product_images', maxCount: 5 },
  { name: 'sample_product_images', maxCount: 5 },
]);

export const uploadProfileImages = multer({ storage, limits: multerLimits }).fields([
  { name: 'avatar', maxCount: 1 },
  { name: 'banner', maxCount: 1 },
]);

const upload = multer({ storage, limits: multerLimits });
export default upload;
