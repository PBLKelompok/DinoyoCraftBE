"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.uploadProfileImages = exports.uploadMitraDocs = exports.getUploadedFileUrl = void 0;
const multer_1 = __importDefault(require("multer"));
const path_1 = __importDefault(require("path"));
const fs_1 = __importDefault(require("fs"));
const cloudinary_js_1 = require("../config/cloudinary.js");
const MAX_UPLOAD_SIZE_BYTES = Number(process.env['UPLOAD_MAX_FILE_SIZE_MB'] || 10) * 1024 * 1024;
/**
 * Tentukan subfolder Cloudinary berdasarkan fieldname & endpoint.
 */
const resolveCloudinarySubfolder = (req, fieldname) => {
    const url = `${req.baseUrl || ''}${req.path || ''}`.toLowerCase();
    if (fieldname === 'ktp_file' || fieldname === 'nib_file') {
        return `${cloudinary_js_1.CLOUDINARY_BASE_FOLDER}/mitra-docs`;
    }
    if (fieldname === 'avatar' || fieldname === 'banner') {
        return `${cloudinary_js_1.CLOUDINARY_BASE_FOLDER}/profiles`;
    }
    if (fieldname === 'product_images' || fieldname === 'sample_product_images') {
        return `${cloudinary_js_1.CLOUDINARY_BASE_FOLDER}/products`;
    }
    if (url.includes('/chat')) {
        return `${cloudinary_js_1.CLOUDINARY_BASE_FOLDER}/chat`;
    }
    if (url.includes('/review')) {
        return `${cloudinary_js_1.CLOUDINARY_BASE_FOLDER}/reviews`;
    }
    if (url.includes('/product') || url.includes('/mitra')) {
        return `${cloudinary_js_1.CLOUDINARY_BASE_FOLDER}/products`;
    }
    return `${cloudinary_js_1.CLOUDINARY_BASE_FOLDER}/uploads`;
};
/**
 * Custom Multer StorageEngine yang streaming langsung ke Cloudinary
 * (zero local disk write — aman untuk container ephemeral seperti Zerops).
 */
class CloudinaryStorageEngine {
    _handleFile(req, file, cb) {
        const folder = resolveCloudinarySubfolder(req, file.fieldname);
        const parsedName = path_1.default.parse(file.originalname || 'file').name;
        const safeSlug = parsedName
            .toLowerCase()
            .replace(/[^a-z0-9-_]+/g, '-')
            .replace(/^-+|-+$/g, '')
            .slice(0, 40);
        const publicId = `${Date.now()}-${Math.round(Math.random() * 1e6)}${safeSlug ? `-${safeSlug}` : ''}`;
        (0, cloudinary_js_1.uploadStreamToCloudinary)(file.stream, {
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
    _removeFile(_req, file, cb) {
        if (file.filename) {
            (0, cloudinary_js_1.deleteFromCloudinary)(file.filename)
                .then(() => cb(null))
                .catch(() => cb(null));
            return;
        }
        cb(null);
    }
}
// Fallback local DiskStorage bila Cloudinary belum dikonfigurasi di .env lokal
const createLocalDiskStorage = () => {
    const targetFolder = path_1.default.join(process.cwd(), 'uploads');
    if (!fs_1.default.existsSync(targetFolder)) {
        fs_1.default.mkdirSync(targetFolder, { recursive: true });
    }
    return multer_1.default.diskStorage({
        destination: (_req, _file, cb) => {
            cb(null, targetFolder);
        },
        filename: (_req, file, cb) => {
            const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1e9);
            cb(null, uniqueSuffix + path_1.default.extname(file.originalname));
        },
    });
};
const storage = cloudinary_js_1.isCloudinaryConfigured
    ? new CloudinaryStorageEngine()
    : createLocalDiskStorage();
const multerLimits = {
    fileSize: MAX_UPLOAD_SIZE_BYTES,
};
/**
 * Ambil URL publik final dari file yang diupload oleh Multer:
 * - Jika Cloudinary aktif: `file.path` berisi `https://res.cloudinary.com/...`
 * - Jika fallback lokal: `/uploads/<filename>`
 */
const getUploadedFileUrl = (file) => {
    if (!file)
        return null;
    if (typeof file.path === 'string' && /^https?:\/\//i.test(file.path)) {
        return file.path;
    }
    if (typeof file.filename === 'string' && file.filename.trim()) {
        return `/uploads/${file.filename.trim()}`;
    }
    return null;
};
exports.getUploadedFileUrl = getUploadedFileUrl;
// Kita gunakan .fields() karena ada beberapa jenis file yang berbeda
exports.uploadMitraDocs = (0, multer_1.default)({ storage, limits: multerLimits }).fields([
    { name: 'ktp_file', maxCount: 1 },
    { name: 'nib_file', maxCount: 1 },
    { name: 'product_images', maxCount: 5 },
    { name: 'sample_product_images', maxCount: 5 },
]);
exports.uploadProfileImages = (0, multer_1.default)({ storage, limits: multerLimits }).fields([
    { name: 'avatar', maxCount: 1 },
    { name: 'banner', maxCount: 1 },
]);
const upload = (0, multer_1.default)({ storage, limits: multerLimits });
exports.default = upload;
//# sourceMappingURL=uploadMiddleware.js.map