// ============================================================
//  src/utils/emailService.ts
//  Email Service — Mendukung Resend (API & SMTP) + Gmail SMTP
// ============================================================

import 'dotenv/config';
import nodemailer from 'nodemailer';

const RESEND_API_ENDPOINT = 'https://api.resend.com/emails';

/**
 * Mengambil Resend API Key jika dikonfigurasi di environment variables.
 */
export const getResendApiKey = (): string => {
  const key = (process.env['RESEND_API_KEY'] || '').trim();
  if (!key || key.includes('your_resend_api_key')) return '';
  return key;
};

/**
 * Menentukan alamat pengirim (From) yang valid untuk Resend maupun SMTP.
 * Prioritas: EMAIL_FROM -> default domain dinoyocraft.my.id (jika pakai Resend) -> EMAIL_USER.
 */
export const getDefaultFromAddress = (): string => {
  const explicitFrom = (process.env['EMAIL_FROM'] || '').trim();
  if (explicitFrom) {
    return explicitFrom.includes('<') ? explicitFrom : `DinoyoCraft <${explicitFrom}>`;
  }

  const smtpHost = (process.env['SMTP_HOST'] || '').trim().toLowerCase();
  if (getResendApiKey() || smtpHost.includes('resend')) {
    return 'DinoyoCraft <noreply@dinoyocraft.my.id>';
  }

  const emailUser = (process.env['EMAIL_USER'] || 'csdinoyocraft@gmail.com').trim();
  return `"DinoyoCraft Portal" <${emailUser}>`;
};

/**
 * Mengecek apakah layanan email (Resend API atau SMTP) sudah dikonfigurasi.
 */
export const isEmailConfigured = (): boolean => {
  if (getResendApiKey()) return true;
  const user = (process.env['EMAIL_USER'] || '').trim();
  const pass = (process.env['EMAIL_PASS'] || '').trim();
  return Boolean(user && pass && pass !== 'xxxx xxxx xxxx xxxx');
};

/**
 * Membuat transporter SMTP secara dinamis dari environment variables.
 * Kompatibel dengan Resend SMTP (smtp.resend.com:587) maupun Gmail SMTP (smtp.gmail.com:587).
 */
export const getTransporter = () => {
  const user = (process.env['EMAIL_USER'] || '').trim();
  const pass = (process.env['EMAIL_PASS'] || '').trim();
  const host = (process.env['SMTP_HOST'] || 'smtp.gmail.com').trim();
  const port = Number(process.env['SMTP_PORT'] || 587);
  const secureEnv = (process.env['SMTP_SECURE'] || '').trim().toLowerCase();
  const secure = secureEnv ? secureEnv === 'true' : port === 465;

  if (!user || !pass) {
    console.error('⚠️ [EMAIL CONFIG] EMAIL_USER atau EMAIL_PASS belum terdefinisi di .env!');
  }

  return nodemailer.createTransport({
    host,
    port,
    secure,
    requireTLS: !secure && port === 587,
    auth: {
      user,
      pass,
    },
    connectionTimeout: 10000,
    greetingTimeout: 10000,
    socketTimeout: 15000,
  });
};

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
export const sendEmail = async (payload: SendEmailPayload): Promise<void> => {
  const from = (payload.from || '').trim() || getDefaultFromAddress();
  const replyTo =
    (payload.replyTo || process.env['EMAIL_REPLY_TO'] || '').trim() || undefined;
  const resendKey = getResendApiKey();

  if (resendKey) {
    const body: Record<string, unknown> = {
      from,
      to: Array.isArray(payload.to) ? payload.to : [payload.to],
      subject: payload.subject,
      html: payload.html,
    };
    if (replyTo) {
      body['reply_to'] = replyTo;
    }

    const res = await fetch(RESEND_API_ENDPOINT, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${resendKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      let detail = `HTTP ${res.status}`;
      try {
        const errJson = (await res.json()) as { message?: string; name?: string };
        detail = errJson.message || errJson.name || detail;
      } catch {
        // ignore JSON parse error
      }
      throw new Error(`Resend API error: ${detail}`);
    }
    return;
  }

  const transporter = getTransporter();
  await transporter.sendMail({
    from,
    to: payload.to,
    subject: payload.subject,
    html: payload.html,
    ...(replyTo ? { replyTo } : {}),
  });
};

export type OtpEmailPurpose =
  | 'register'
  | 'reset_password'
  | 'login'
  | '2fa_enable'
  | '2fa_disable';

const EMAIL_ASSETS = {
  logo: 'https://raw.githubusercontent.com/alifarda126/DinoyoCraftApp/main/assets/images/branding/Logo.png',
  lockKey2fa:
    'https://res.cloudinary.com/o2cur2h4/image/upload/v1795519177/dinoyocraft/email-assets/2fa-lock-key.gif',
  otpShimmer:
    'https://res.cloudinary.com/o2cur2h4/image/upload/v1795519178/dinoyocraft/email-assets/otp-shimmer-bar.gif',
  otpVerify:
    'https://res.cloudinary.com/o2cur2h4/image/upload/v1795519179/dinoyocraft/email-assets/otp-verify-mark.gif',
} as const;

const escapeHtml = (str: string): string =>
  str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');

const PURPOSE_COPY: Record<
  OtpEmailPurpose,
  {
    subject: string;
    tag: string;
    heading: string;
    description: string;
    useLockAnimation: boolean;
  }
> = {
  register: {
    subject: 'Kode Verifikasi Akun — DinoyoCraft',
    tag: 'VERIFIKASI',
    heading: 'Verifikasi alamat email Anda',
    description:
      'Gunakan kode sekali pakai di bawah ini untuk menyelesaikan pendaftaran akun DinoyoCraft Anda.',
    useLockAnimation: false,
  },
  reset_password: {
    subject: 'Atur Ulang Kata Sandi — DinoyoCraft',
    tag: 'KEAMANAN',
    heading: 'Permintaan atur ulang kata sandi',
    description:
      'Masukkan kode verifikasi berikut untuk membuat kata sandi baru pada akun DinoyoCraft Anda.',
    useLockAnimation: false,
  },
  login: {
    subject: 'Kode Masuk 2FA — DinoyoCraft',
    tag: '2FA AKSES',
    heading: 'Konfirmasi percobaan masuk',
    description:
      'Akun Anda dilindungi autentikasi dua langkah. Masukkan kode berikut untuk melanjutkan proses masuk.',
    useLockAnimation: true,
  },
  '2fa_enable': {
    subject: 'Aktivasi Autentikasi Dua Langkah — DinoyoCraft',
    tag: '2FA KEAMANAN',
    heading: 'Aktifkan autentikasi dua langkah',
    description:
      'Masukkan kode verifikasi di bawah ini untuk mengunci dan melindungi akun DinoyoCraft Anda dengan autentikasi dua langkah.',
    useLockAnimation: true,
  },
  '2fa_disable': {
    subject: 'Nonaktifkan Autentikasi Dua Langkah — DinoyoCraft',
    tag: '2FA KEAMANAN',
    heading: 'Konfirmasi penonaktifan 2FA',
    description:
      'Masukkan kode verifikasi berikut untuk menonaktifkan autentikasi dua langkah pada akun DinoyoCraft Anda.',
    useLockAnimation: true,
  },
};

/**
 * Kirim kode OTP ke email asli user dengan desain minimalis monokrom DinoyoCraft
 */
export const sendOTPEmail = async (
  toEmail: string,
  otpCode: string,
  recipientName: string = 'Pengguna',
  purpose: OtpEmailPurpose = 'register'
): Promise<void> => {
  const copy = PURPOSE_COPY[purpose] || PURPOSE_COPY.register;
  const safeName = escapeHtml((recipientName || 'Pengguna').trim());
  const safeOtp = escapeHtml(String(otpCode).trim());
  const heroGifUrl = copy.useLockAnimation ? EMAIL_ASSETS.lockKey2fa : EMAIL_ASSETS.otpVerify;
  const heroWidth = copy.useLockAnimation ? 80 : 56;
  const heroHeight = 56;
  const heroAlt = copy.useLockAnimation
    ? 'Animasi kunci dan gembok keamanan 2FA DinoyoCraft'
    : 'Animasi verifikasi OTP DinoyoCraft';

  const mailOptions = {
    from: getDefaultFromAddress(),
    to: toEmail,
    subject: copy.subject,
    html: `
      <!DOCTYPE html>
      <html lang="id">
      <head>
        <meta charset="UTF-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <meta name="color-scheme" content="light dark">
        <meta name="supported-color-schemes" content="light dark">
        <title>${copy.subject}</title>
        <style>
          @keyframes otpReveal {
            0% { opacity: 0.25; transform: translateY(4px); letter-spacing: 0.18em; }
            100% { opacity: 1; transform: translateY(0); letter-spacing: 0.28em; }
          }
          .otp-code-text {
            animation: otpReveal 0.65s cubic-bezier(0.22, 1, 0.36, 1) forwards;
          }
        </style>
      </head>
      <body style="margin: 0; padding: 0; background-color: #F4F4F5; font-family: -apple-system, BlinkMacSystemFont, 'Inter', 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; -webkit-font-smoothing: antialiased; color: #0A0A0A;">
        <div style="display: none; max-height: 0; overflow: hidden; opacity: 0; mso-hide: all;">
          Kode verifikasi DinoyoCraft Anda: ${safeOtp} — berlaku selama 5 menit.
        </div>

        <table role="presentation" border="0" cellpadding="0" cellspacing="0" width="100%" style="background-color: #F4F4F5; padding: 36px 16px;">
          <tr>
            <td align="center">
              <table role="presentation" border="0" cellpadding="0" cellspacing="0" width="100%" style="max-width: 520px; background-color: #FFFFFF; border-radius: 16px; border: 1px solid #E4E4E7; overflow: hidden;">

                <!-- Header Lockup -->
                <tr>
                  <td style="padding: 28px 32px 22px; border-bottom: 1px solid #F0F0F2;">
                    <table role="presentation" border="0" cellpadding="0" cellspacing="0" width="100%">
                      <tr>
                        <td align="left" valign="middle">
                          <table role="presentation" border="0" cellpadding="0" cellspacing="0">
                            <tr>
                              <td valign="middle" style="width: 36px; height: 36px; background-color: #FFFFFF; border: 1px solid #E4E4E7; border-radius: 10px; text-align: center; padding: 4px;">
                                <img src="${EMAIL_ASSETS.logo}" alt="DinoyoCraft" width="26" height="26" style="width: 26px; height: 26px; object-fit: contain; display: block; margin: 0 auto; border: 0;" />
                              </td>
                              <td valign="middle" style="padding-left: 12px;">
                                <span style="font-size: 16px; font-weight: 700; color: #0A0A0A; letter-spacing: -0.03em; line-height: 1;">DinoyoCraft</span>
                              </td>
                            </tr>
                          </table>
                        </td>
                        <td align="right" valign="middle">
                          <span style="display: inline-block; font-family: 'SFMono-Regular', Consolas, 'Liberation Mono', Menlo, monospace; font-size: 10px; font-weight: 600; letter-spacing: 0.14em; color: #71717A; text-transform: uppercase; border: 1px solid #E4E4E7; border-radius: 6px; padding: 4px 8px; background-color: #FAFAFA;">
                            ${copy.tag}
                          </span>
                        </td>
                      </tr>
                    </table>
                  </td>
                </tr>

                <!-- Main Body -->
                <tr>
                  <td style="padding: 32px 32px 28px;">

                    <!-- Animated Monochrome Icon -->
                    <table role="presentation" border="0" cellpadding="0" cellspacing="0" width="100%" style="margin-bottom: 22px;">
                      <tr>
                        <td align="left">
                          <img src="${heroGifUrl}" alt="${heroAlt}" width="${heroWidth}" height="${heroHeight}" style="width: ${heroWidth}px; height: ${heroHeight}px; display: block; border: 0; border-radius: 12px;" />
                        </td>
                      </tr>
                    </table>

                    <!-- Title & Copy -->
                    <h1 style="margin: 0 0 10px; font-size: 21px; font-weight: 700; color: #0A0A0A; letter-spacing: -0.03em; line-height: 1.3;">
                      ${copy.heading}
                    </h1>
                    <p style="margin: 0 0 6px; font-size: 14px; color: #27272A; line-height: 1.6;">
                      Halo <strong>${safeName}</strong>,
                    </p>
                    <p style="margin: 0 0 26px; font-size: 14px; color: #52525B; line-height: 1.65;">
                      ${copy.description}
                    </p>

                    <!-- OTP Surface -->
                    <table role="presentation" border="0" cellpadding="0" cellspacing="0" width="100%" style="background-color: #FAFAFA; border: 1px solid #E4E4E7; border-radius: 12px; margin-bottom: 22px;">
                      <tr>
                        <td align="center" style="padding: 24px 20px 22px;">
                          <div style="font-family: 'SFMono-Regular', Consolas, 'Liberation Mono', Menlo, monospace; font-size: 10px; font-weight: 600; letter-spacing: 0.16em; color: #71717A; text-transform: uppercase; margin-bottom: 12px;">
                            Kode Verifikasi Sekali Pakai
                          </div>
                          <div class="otp-code-text" style="font-family: 'SFMono-Regular', Consolas, 'Liberation Mono', Menlo, monospace; font-size: 36px; font-weight: 700; letter-spacing: 0.28em; text-indent: 0.28em; color: #0A0A0A; line-height: 1.2; padding: 4px 0 16px;">
                            ${safeOtp}
                          </div>
                          <table role="presentation" border="0" cellpadding="0" cellspacing="0" style="margin: 0 auto 14px;">
                            <tr>
                              <td align="center">
                                <img src="${EMAIL_ASSETS.otpShimmer}" alt="" width="200" height="6" style="width: 200px; height: 6px; display: block; border: 0; border-radius: 999px;" />
                              </td>
                            </tr>
                          </table>
                          <div style="font-size: 12px; color: #71717A; line-height: 1.5;">
                            Berlaku selama <strong style="color: #18181B; font-weight: 600;">5 menit</strong> &middot; Jangan bagikan kode ini kepada siapa pun
                          </div>
                        </td>
                      </tr>
                    </table>

                    <!-- Quiet Security Note -->
                    <p style="margin: 0; font-size: 12.5px; color: #71717A; line-height: 1.6;">
                      Tim DinoyoCraft tidak pernah meminta kode verifikasi Anda melalui telepon, pesan instan, atau email. Jika Anda tidak melakukan permintaan ini, abaikan email ini dengan aman.
                    </p>
                  </td>
                </tr>

                <!-- Minimal Footer -->
                <tr>
                  <td style="padding: 20px 32px 24px; border-top: 1px solid #F0F0F2; background-color: #FAFAFA;">
                    <table role="presentation" border="0" cellpadding="0" cellspacing="0" width="100%">
                      <tr>
                        <td style="font-size: 11.5px; color: #71717A; line-height: 1.6;">
                          <strong style="color: #18181B; font-weight: 600;">DinoyoCraft</strong> &mdash; Sentra Kerajinan Keramik Dinoyo, Malang<br/>
                          <a href="https://dinoyocraft.my.id" style="color: #52525B; text-decoration: none;">dinoyocraft.my.id</a>
                          &nbsp;&middot;&nbsp;
                          &copy; ${new Date().getFullYear()} DinoyoCraft
                        </td>
                      </tr>
                    </table>
                  </td>
                </tr>

              </table>
            </td>
          </tr>
        </table>
      </body>
      </html>
    `,
  };

  try {
    await sendEmail(mailOptions);
    const provider = getResendApiKey() ? 'Resend API' : (process.env['SMTP_HOST'] || 'SMTP');
    console.log(`✅ [EMAIL SUCCESS] Kode OTP berhasil dikirim ke: ${toEmail} via ${provider}`);
  } catch (error: any) {
    console.error(`❌ [EMAIL ERROR] Gagal mengirim email OTP ke ${toEmail}:`, error.message);
    throw error;
  }
};
