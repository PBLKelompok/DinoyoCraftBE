"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.decryptMessage = exports.encryptMessage = void 0;
const crypto_1 = __importDefault(require("crypto"));
const ALGORITHM = 'aes-256-cbc';
// Pastikan panjang kunci selalu 32 byte untuk AES-256-CBC tanpa mematahkan kunci 32-byte eksisting
const RAW_SECRET_KEY = process.env.ENCRYPTION_KEY || 'dinoyocraft_secret_key_32_chars!';
const KEY_BUFFER = Buffer.byteLength(RAW_SECRET_KEY, 'utf8') === 32
    ? Buffer.from(RAW_SECRET_KEY, 'utf8')
    : crypto_1.default.createHash('sha256').update(RAW_SECRET_KEY, 'utf8').digest();
const IV_LENGTH = 16;
const encryptMessage = (text) => {
    const iv = crypto_1.default.randomBytes(IV_LENGTH);
    const cipher = crypto_1.default.createCipheriv(ALGORITHM, KEY_BUFFER, iv);
    let encrypted = cipher.update(text);
    encrypted = Buffer.concat([encrypted, cipher.final()]);
    return iv.toString('hex') + ':' + encrypted.toString('hex');
};
exports.encryptMessage = encryptMessage;
const decryptMessage = (text) => {
    try {
        const textParts = text.split(':');
        // Jika format tidak sesuai (misal: pesan lama yang belum dienkripsi), kembalikan teks aslinya
        if (textParts.length !== 2)
            return text;
        const iv = Buffer.from(textParts.shift(), 'hex');
        const encryptedText = Buffer.from(textParts.join(':'), 'hex');
        const decipher = crypto_1.default.createDecipheriv(ALGORITHM, KEY_BUFFER, iv);
        let decrypted = decipher.update(encryptedText);
        decrypted = Buffer.concat([decrypted, decipher.final()]);
        return decrypted.toString();
    }
    catch (error) {
        return text; // Fallback jika gagal dekripsi (pesan lama)
    }
};
exports.decryptMessage = decryptMessage;
//# sourceMappingURL=encryption.js.map