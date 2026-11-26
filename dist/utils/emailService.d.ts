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
 * Kirim kode OTP ke email asli user dengan desain minimalis monokrom DinoyoCraft
 */
export declare const sendOTPEmail: (toEmail: string, otpCode: string, recipientName?: string, purpose?: OtpEmailPurpose) => Promise<void>;
/**
 * Kirim email pemberitahuan resmi bahwa pengajuan penghapusan akun telah disetujui oleh Admin
 */
export declare const sendAccountDeletionApprovedEmail: (toEmail: string, recipientName?: string) => Promise<void>;
/**
 * Kirim email peringatan keamanan ketika terdapat perangkat baru/lain yang login ke akun pelanggan
 */
export declare const sendNewDeviceLoginAlertEmail: (toEmail: string, recipientName: string | undefined, details: {
    deviceName: string;
    ipAddress?: string;
    loginTimeWib?: string;
    authMethod?: string;
}) => Promise<void>;
//# sourceMappingURL=emailService.d.ts.map