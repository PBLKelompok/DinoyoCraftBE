import multer from 'multer';
/**
 * Ambil URL publik final dari file yang diupload oleh Multer:
 * - Jika Cloudinary aktif: `file.path` berisi `https://res.cloudinary.com/...`
 * - Jika fallback lokal: `/uploads/<filename>`
 */
export declare const getUploadedFileUrl: (file?: Partial<Express.Multer.File> | null) => string | null;
export declare const uploadMitraDocs: import("express").RequestHandler<import("express-serve-static-core").ParamsDictionary, any, any, import("qs").ParsedQs, Record<string, any>>;
export declare const uploadProfileImages: import("express").RequestHandler<import("express-serve-static-core").ParamsDictionary, any, any, import("qs").ParsedQs, Record<string, any>>;
declare const upload: multer.Multer;
export default upload;
//# sourceMappingURL=uploadMiddleware.d.ts.map