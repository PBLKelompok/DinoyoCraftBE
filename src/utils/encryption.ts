import crypto from 'crypto';

const ALGORITHM = 'aes-256-cbc';
// Pastikan panjang kunci selalu 32 byte untuk AES-256-CBC tanpa mematahkan kunci 32-byte eksisting
const RAW_SECRET_KEY = process.env.ENCRYPTION_KEY || 'dinoyocraft_secret_key_32_chars!';
const KEY_BUFFER: Buffer =
    Buffer.byteLength(RAW_SECRET_KEY, 'utf8') === 32
        ? Buffer.from(RAW_SECRET_KEY, 'utf8')
        : crypto.createHash('sha256').update(RAW_SECRET_KEY, 'utf8').digest();
const IV_LENGTH = 16;

export const encryptMessage = (text: string): string => {
    const iv = crypto.randomBytes(IV_LENGTH);
    const cipher = crypto.createCipheriv(ALGORITHM, KEY_BUFFER, iv);
    let encrypted = cipher.update(text);
    encrypted = Buffer.concat([encrypted, cipher.final()]);
    return iv.toString('hex') + ':' + encrypted.toString('hex');
};

export const decryptMessage = (text: string): string => {
    try {
        const textParts = text.split(':');
        // Jika format tidak sesuai (misal: pesan lama yang belum dienkripsi), kembalikan teks aslinya
        if (textParts.length !== 2) return text;

        const iv = Buffer.from(textParts.shift() as string, 'hex');
        const encryptedText = Buffer.from(textParts.join(':'), 'hex');
        const decipher = crypto.createDecipheriv(ALGORITHM, KEY_BUFFER, iv);

        let decrypted = decipher.update(encryptedText);
        decrypted = Buffer.concat([decrypted, decipher.final()]);

        return decrypted.toString();
    } catch (error) {
        return text; // Fallback jika gagal dekripsi (pesan lama)
    }
};