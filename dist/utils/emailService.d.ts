import 'dotenv/config';
/**
 * Membuat transporter Gmail SMTP secara dinamis dari environment variables
 */
export declare const getTransporter: () => import("nodemailer").Mail<import("nodemailer").SMTPSentMessageInfo, import("nodemailer").SMTPTransportOptions>;
export type OtpEmailPurpose = 'register' | 'reset_password' | 'login' | '2fa_enable' | '2fa_disable';
/**
 * Kirim kode OTP ke email asli user dengan template branded DinoyoCraft
 */
export declare const sendOTPEmail: (toEmail: string, otpCode: string, recipientName?: string, purpose?: OtpEmailPurpose) => Promise<void>;
//# sourceMappingURL=emailService.d.ts.map