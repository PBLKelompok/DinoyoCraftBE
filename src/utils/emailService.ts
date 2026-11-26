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
  glassBg:
    'https://res.cloudinary.com/o2cur2h4/image/upload/v1795519562/dinoyocraft/email-assets/email-glass-bg.png',
  lockKey2fa:
    'https://res.cloudinary.com/o2cur2h4/image/upload/v1795519564/dinoyocraft/email-assets/2fa-lock-key-glass.gif',
  otpShimmer:
    'https://res.cloudinary.com/o2cur2h4/image/upload/v1795519566/dinoyocraft/email-assets/otp-shimmer-glass.gif',
  otpVerify:
    'https://res.cloudinary.com/o2cur2h4/image/upload/v1795519565/dinoyocraft/email-assets/otp-verify-glass.gif',
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
  const heroWidth = copy.useLockAnimation ? 96 : 64;
  const heroHeight = copy.useLockAnimation ? 61 : 64;
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
        <meta name="color-scheme" content="dark light">
        <meta name="supported-color-schemes" content="dark light">
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
      <body style="margin: 0; padding: 0; background-color: #0D0D10; font-family: -apple-system, BlinkMacSystemFont, 'Inter', 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; -webkit-font-smoothing: antialiased; color: #FFFFFF;">
        <div style="display: none; max-height: 0; overflow: hidden; opacity: 0; mso-hide: all;">
          Kode verifikasi DinoyoCraft Anda: ${safeOtp} — berlaku selama 5 menit.
        </div>

        <table role="presentation" border="0" cellpadding="0" cellspacing="0" width="100%" style="background-color: #0D0D10; background-image: linear-gradient(145deg, #0A0A0C 0%, #1C1C22 50%, #101014 100%); padding: 32px 14px;">
          <tr>
            <td align="center">
              <!-- Outer Monochrome Glassmorphism Canvas -->
              <table role="presentation" border="0" cellpadding="0" cellspacing="0" width="100%" background="${EMAIL_ASSETS.glassBg}" style="max-width: 520px; background-color: #16161B; background-image: url('${EMAIL_ASSETS.glassBg}'); background-size: cover; background-position: center top; background-repeat: no-repeat; border-radius: 20px; border: 1px solid rgba(255, 255, 255, 0.16); overflow: hidden;">

                <!-- Header Lockup (Frosted Glass Strip) -->
                <tr>
                  <td style="padding: 24px 28px 20px; background-color: rgba(10, 10, 13, 0.48); border-bottom: 1px solid rgba(255, 255, 255, 0.12); backdrop-filter: blur(14px); -webkit-backdrop-filter: blur(14px);">
                    <table role="presentation" border="0" cellpadding="0" cellspacing="0" width="100%">
                      <tr>
                        <td align="left" valign="middle">
                          <table role="presentation" border="0" cellpadding="0" cellspacing="0">
                            <tr>
                              <td valign="middle" style="width: 34px; height: 34px; background-color: #FFFFFF; border: 1px solid rgba(255, 255, 255, 0.35); border-radius: 10px; text-align: center; padding: 4px;">
                                <img src="${EMAIL_ASSETS.logo}" alt="DinoyoCraft" width="24" height="24" style="width: 24px; height: 24px; object-fit: contain; display: block; margin: 0 auto; border: 0;" />
                              </td>
                              <td valign="middle" style="padding-left: 11px;">
                                <span style="font-size: 16px; font-weight: 700; color: #FFFFFF; letter-spacing: -0.03em; line-height: 1;">DinoyoCraft</span>
                              </td>
                            </tr>
                          </table>
                        </td>
                        <td align="right" valign="middle">
                          <span style="display: inline-block; font-family: 'SFMono-Regular', Consolas, 'Liberation Mono', Menlo, monospace; font-size: 10px; font-weight: 600; letter-spacing: 0.14em; color: #E4E4E7; text-transform: uppercase; border: 1px solid rgba(255, 255, 255, 0.22); border-radius: 999px; padding: 5px 10px; background-color: rgba(255, 255, 255, 0.08);">
                            ${copy.tag}
                          </span>
                        </td>
                      </tr>
                    </table>
                  </td>
                </tr>

                <!-- Main Frosted Body -->
                <tr>
                  <td style="padding: 32px 28px 28px; background-color: rgba(12, 12, 16, 0.36);">

                    <!-- Title (Centered) -->
                    <h1 style="margin: 0 0 22px; text-align: center; font-size: 22px; font-weight: 700; color: #FFFFFF; letter-spacing: -0.03em; line-height: 1.3;">
                      ${copy.heading}
                    </h1>

                    <!-- Centered Animated Monochrome Glass Icon (Below Title) -->
                    <table role="presentation" border="0" cellpadding="0" cellspacing="0" width="100%" style="margin-bottom: 24px;">
                      <tr>
                        <td align="center">
                          <table role="presentation" border="0" cellpadding="0" cellspacing="0" style="margin: 0 auto; border-radius: 16px; border: 1px solid rgba(255, 255, 255, 0.24); overflow: hidden; background-color: rgba(255, 255, 255, 0.06);">
                            <tr>
                              <td align="center" style="padding: 0; line-height: 0;">
                                <img src="${heroGifUrl}" alt="${heroAlt}" width="${heroWidth}" height="${heroHeight}" style="width: ${heroWidth}px; height: ${heroHeight}px; display: block; border: 0; border-radius: 15px;" />
                              </td>
                            </tr>
                          </table>
                        </td>
                      </tr>
                    </table>

                    <!-- Copy -->
                    <p style="margin: 0 0 6px; text-align: center; font-size: 14.5px; color: #F4F4F5; line-height: 1.6;">
                      Halo <strong style="color: #FFFFFF;">${safeName}</strong>,
                    </p>
                    <p style="margin: 0 auto 26px; max-width: 400px; text-align: center; font-size: 13.5px; color: #D4D4D8; line-height: 1.65;">
                      ${copy.description}
                    </p>

                    <!-- OTP Frosted Glass Surface -->
                    <table role="presentation" border="0" cellpadding="0" cellspacing="0" width="100%" style="background-color: rgba(10, 10, 14, 0.58); border: 1px solid rgba(255, 255, 255, 0.2); border-radius: 16px; margin-bottom: 22px; backdrop-filter: blur(18px); -webkit-backdrop-filter: blur(18px);">
                      <tr>
                        <td align="center" style="padding: 24px 18px 22px;">
                          <div style="font-family: 'SFMono-Regular', Consolas, 'Liberation Mono', Menlo, monospace; font-size: 10px; font-weight: 600; letter-spacing: 0.16em; color: #A1A1AA; text-transform: uppercase; margin-bottom: 12px;">
                            Kode Verifikasi Sekali Pakai
                          </div>
                          <div class="otp-code-text" style="font-family: 'SFMono-Regular', Consolas, 'Liberation Mono', Menlo, monospace; font-size: 36px; font-weight: 700; letter-spacing: 0.28em; text-indent: 0.28em; color: #FFFFFF; line-height: 1.2; padding: 4px 0 16px;">
                            ${safeOtp}
                          </div>
                          <table role="presentation" border="0" cellpadding="0" cellspacing="0" style="margin: 0 auto 14px;">
                            <tr>
                              <td align="center">
                                <img src="${EMAIL_ASSETS.otpShimmer}" alt="" width="200" height="6" style="width: 200px; height: 6px; display: block; border: 0; border-radius: 999px;" />
                              </td>
                            </tr>
                          </table>
                          <div style="font-size: 12px; color: #A1A1AA; line-height: 1.55;">
                            Berlaku selama <strong style="color: #F4F4F5; font-weight: 600;">5 menit</strong> &middot; Jangan bagikan kode ini kepada siapa pun
                          </div>
                        </td>
                      </tr>
                    </table>

                    <!-- Quiet Security Note -->
                    <p style="margin: 0; text-align: center; font-size: 12px; color: #A1A1AA; line-height: 1.6;">
                      Tim DinoyoCraft tidak pernah meminta kode verifikasi Anda. Jika Anda tidak melakukan permintaan ini, abaikan email ini dengan aman.
                    </p>
                  </td>
                </tr>

                <!-- Minimal Frosted Footer -->
                <tr>
                  <td align="center" style="padding: 18px 28px 22px; background-color: rgba(8, 8, 11, 0.62); border-top: 1px solid rgba(255, 255, 255, 0.1); backdrop-filter: blur(14px); -webkit-backdrop-filter: blur(14px);">
                    <div style="font-size: 11.5px; color: #A1A1AA; line-height: 1.65;">
                      <strong style="color: #F4F4F5; font-weight: 600;">DinoyoCraft</strong> &mdash; Sentra Kerajinan Keramik Dinoyo, Malang<br/>
                      <a href="https://dinoyocraft.my.id" style="color: #D4D4D8; text-decoration: none;">dinoyocraft.my.id</a>
                      &nbsp;&middot;&nbsp;
                      &copy; ${new Date().getFullYear()} DinoyoCraft
                    </div>
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

/**
 * Kirim email pemberitahuan resmi bahwa pengajuan penghapusan akun telah disetujui oleh Admin
 */
export const sendAccountDeletionApprovedEmail = async (
  toEmail: string,
  recipientName: string = 'Pelanggan'
): Promise<void> => {
  const safeName = escapeHtml((recipientName || 'Pelanggan').trim());
  const safeEmail = escapeHtml(toEmail.trim());
  const subject = 'Penghapusan Akun Disetujui — DinoyoCraft';

  const html = `
    <!DOCTYPE html>
    <html lang="id">
    <head>
      <meta charset="UTF-8">
      <meta name="viewport" content="width=device-width, initial-scale=1.0">
      <title>${subject}</title>
    </head>
    <body style="margin: 0; padding: 0; background-color: #0D0D10; font-family: -apple-system, BlinkMacSystemFont, 'Inter', 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; color: #FFFFFF;">
      <table role="presentation" border="0" cellpadding="0" cellspacing="0" width="100%" style="background-color: #0D0D10; padding: 32px 14px;">
        <tr>
          <td align="center">
            <table role="presentation" border="0" cellpadding="0" cellspacing="0" width="100%" style="max-width: 520px; background-color: #16161B; border-radius: 20px; border: 1px solid rgba(255, 255, 255, 0.16); overflow: hidden;">
              <tr>
                <td style="padding: 24px 28px 20px; background-color: rgba(10, 10, 13, 0.65); border-bottom: 1px solid rgba(255, 255, 255, 0.12);">
                  <table role="presentation" border="0" cellpadding="0" cellspacing="0" width="100%">
                    <tr>
                      <td align="left" valign="middle">
                        <table role="presentation" border="0" cellpadding="0" cellspacing="0">
                          <tr>
                            <td valign="middle" style="width: 34px; height: 34px; background-color: #FFFFFF; border-radius: 10px; text-align: center; padding: 4px;">
                              <img src="${EMAIL_ASSETS.logo}" alt="DinoyoCraft" width="24" height="24" style="width: 24px; height: 24px; object-fit: contain; display: block; margin: 0 auto; border: 0;" />
                            </td>
                            <td valign="middle" style="padding-left: 11px;">
                              <span style="font-size: 16px; font-weight: 700; color: #FFFFFF;">DinoyoCraft</span>
                            </td>
                          </tr>
                        </table>
                      </td>
                      <td align="right" valign="middle">
                        <span style="display: inline-block; font-family: monospace; font-size: 10px; font-weight: 600; letter-spacing: 0.12em; color: #FCA5A5; text-transform: uppercase; border: 1px solid rgba(248, 113, 113, 0.35); border-radius: 999px; padding: 5px 10px; background-color: rgba(239, 68, 68, 0.12);">
                          AKUN DIHAPUS
                        </span>
                      </td>
                    </tr>
                  </table>
                </td>
              </tr>
              <tr>
                <td style="padding: 32px 28px 28px;">
                  <h1 style="margin: 0 0 16px; text-align: center; font-size: 21px; font-weight: 700; color: #FFFFFF; line-height: 1.35;">
                    Pengajuan Penghapusan Akun Disetujui
                  </h1>
                  <p style="margin: 0 0 12px; text-align: center; font-size: 14.5px; color: #F4F4F5; line-height: 1.6;">
                    Halo <strong style="color: #FFFFFF;">${safeName}</strong>,
                  </p>
                  <p style="margin: 0 auto 22px; max-width: 420px; text-align: center; font-size: 13.5px; color: #D4D4D8; line-height: 1.65;">
                    Permohonan penghapusan akun DinoyoCraft Anda (<strong style="color: #FFFFFF;">${safeEmail}</strong>) telah ditinjau dan <strong style="color: #FFFFFF;">disetujui</strong> oleh tim Admin DinoyoCraft.
                  </p>
                  <table role="presentation" border="0" cellpadding="0" cellspacing="0" width="100%" style="background-color: rgba(10, 10, 14, 0.65); border: 1px solid rgba(255, 255, 255, 0.16); border-radius: 14px; margin-bottom: 20px;">
                    <tr>
                      <td style="padding: 18px 20px; font-size: 12.5px; color: #D4D4D8; line-height: 1.65;">
                        &bull; Seluruh sesi login aktif pada perangkat Anda telah diakhiri secara otomatis.<br/>
                        &bull; Akun Anda kini telah dinonaktifkan dan tidak dapat lagi digunakan untuk masuk.<br/>
                        &bull; Terima kasih telah menjadi bagian dari komunitas pecinta keramik Dinoyo, Malang.
                      </td>
                    </tr>
                  </table>
                  <p style="margin: 0; text-align: center; font-size: 12px; color: #A1A1AA; line-height: 1.6;">
                    Apabila Anda memiliki pertanyaan lebih lanjut, silakan hubungi <a href="mailto:support@dinoyocraft.my.id" style="color: #E4E4E7;">support@dinoyocraft.my.id</a>.
                  </p>
                </td>
              </tr>
              <tr>
                <td align="center" style="padding: 18px 28px 22px; background-color: rgba(8, 8, 11, 0.62); border-top: 1px solid rgba(255, 255, 255, 0.1);">
                  <div style="font-size: 11.5px; color: #A1A1AA; line-height: 1.65;">
                    <strong style="color: #F4F4F5;">DinoyoCraft</strong> &mdash; Sentra Kerajinan Keramik Dinoyo, Malang<br/>
                    &copy; ${new Date().getFullYear()} DinoyoCraft
                  </div>
                </td>
              </tr>
            </table>
          </td>
        </tr>
      </table>
    </body>
    </html>
  `;

  await sendEmail({
    from: getDefaultFromAddress(),
    to: toEmail,
    subject,
    html,
  });
};
