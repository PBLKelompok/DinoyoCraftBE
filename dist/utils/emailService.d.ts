import 'dotenv/config';
/**
 * Mengambil Resend API Key jika dikonfigurasi di environment variables.
 */
export declare const getResendApiKey: () => string;
/**
 * Menentukan alamat pengirim (From) yang valid untuk Resend maupun SMTP.
 * Prioritas: EMAIL_FROM -> default domain dinoyocraft.my.id (jika pakai Resend) -> EMAIL_USER.
 */
export declare const getDefaultFromAddress: () => string;
/**
 * Mengecek apakah layanan email (Resend API atau SMTP) sudah dikonfigurasi.
 */
export declare const isEmailConfigured: () => boolean;
/**
 * Membuat transporter SMTP secara dinamis dari environment variables.
 * Kompatibel dengan Resend SMTP (smtp.resend.com:587) maupun Gmail SMTP (smtp.gmail.com:587).
 */
export declare const getTransporter: () => import("nodemailer").Mail<import("nodemailer").SMTPSentMessageInfo, import("nodemailer").SMTPTransportOptions>;
export interface SendEmailPayload {
    to: string | string[];
    subject: string;
    html: string;
    from?: string;
    replyTo?: string;
}
/**
 * Mengirim email melalui Resend HTTPS API (prioritas bila RESEND_API_KEY diisi)
 * atau fallback otomatis ke SMTP Nodemailer (Resend SMTP / Gmail SMTP).
 */
export declare const sendEmail: (payload: SendEmailPayload) => Promise<void>;
export type OtpEmailPurpose = 'register' | 'reset_password' | 'login' | '2fa_enable' | '2fa_disable';
/**
 * Kirim kode OTP ke email asli user dengan template branded DinoyoCraft
 */
export declare const sendOTPEmail: (toEmail: string, otpCode: string, recipientName?: string, purpose?: OtpEmailPurpose) => Promise<void>;
//# sourceMappingURL=emailService.d.ts.map