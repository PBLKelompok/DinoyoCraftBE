import {
  sendOTPEmail,
  sendEmail,
  isEmailConfigured,
  getDefaultFromAddress,
} from '../utils/emailService.js';
import { Request, Response } from 'express';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { OAuth2Client } from 'google-auth-library';
import db from '../config/database';
import { getUploadedFileUrl } from '../middlewares/uploadMiddleware.js';

// ============================================================
// Helper JWT — Access + Refresh Token Pair
// ============================================================
interface TokenPair {
  token: string;
  refresh_token: string;
}

const signTokenPair = (user: { id: number; email: string; role: string; ver?: number }): TokenPair => {
  const jwtSecret = process.env['JWT_SECRET'];
  if (!jwtSecret) throw new Error('JWT_SECRET tidak ditemukan di environment variables!');

  const refreshSecret = process.env['JWT_REFRESH_SECRET'] || jwtSecret;
  const jwtExpiresIn = process.env['JWT_EXPIRES_IN'] || '7d';
  const refreshExpiresIn = process.env['JWT_REFRESH_EXPIRES_IN'] || '30d';

  const ver = user.ver ?? 0;

  const token = jwt.sign(
    { userId: user.id, email: user.email, role: user.role, ver },
    jwtSecret,
    { expiresIn: jwtExpiresIn as any }
  );

  const refresh_token = jwt.sign(
    { userId: user.id, email: user.email, role: user.role, ver, type: 'refresh' },
    refreshSecret,
    { expiresIn: refreshExpiresIn as any }
  );

  return { token, refresh_token };
};

const applyMitraPendingAuthLog = (
  res: Response,
  opts: {
    userId: number;
    email: string;
    storeName?: string | null;
    ownerName?: string | null;
    isVerified?: number | null;
    rejectionReason?: string | null;
    isRegistration?: boolean;
    authMethod?: 'password' | 'google' | 'otp_2fa';
  }
): void => {
  const verifiedNum = Number(opts.isVerified ?? 0);
  const isRejected = verifiedNum === 2 || Boolean(opts.rejectionReason);
  const storeLabel = opts.storeName || opts.ownerName || 'Toko Mitra';
  res.locals['userId'] = opts.userId;
  res.locals['role'] = 'mitra';
  res.locals['logCategory'] = 'auth';
  res.locals['logSeverity'] = 'info';
  res.locals['logOutcome'] = 'pending';
  if (opts.isRegistration) {
    res.locals['logEventName'] = 'auth.mitra.register_pending';
    res.locals['logMessage'] = `Pendaftaran Mitra baru "${storeLabel}" (${opts.email}) berhasil dikirim — menunggu persetujuan verifikasi Admin (PENDING)`;
  } else {
    res.locals['logEventName'] = 'auth.mitra.login_pending_verification';
    const statusNote = isRejected
      ? 'pengajuan sebelumnya ditolak, menunggu perbaikan dokumen & verifikasi ulang Admin'
      : 'pendaftaran toko belum disetujui, menunggu verifikasi Admin';
    res.locals['logMessage'] = `Login Mitra "${storeLabel}" (${opts.email}) berhasil (akses terbatas Profil Toko) — ${statusNote} (PENDING)`;
  }
  res.locals['logMetadata'] = {
    email: opts.email,
    role: 'mitra',
    storeName: opts.storeName || null,
    authMethod: opts.authMethod || 'password',
    isVerified: verifiedNum,
    verificationStatus: isRejected ? 'rejected_awaiting_resubmission' : 'pending_approval',
    rejectionReason: opts.rejectionReason || null,
    accessScope: opts.isRegistration ? 'awaiting_login' : 'profile_only',
  };
};


export const registerCustomer = async (req: Request, res: Response): Promise<void> => {
  try {
    const { name, email, password, phone, username, birth_date, birthDate, google_id, avatar_url, isGoogleAuth } = req.body;
    const isGoogle = Boolean(isGoogleAuth || google_id);
    const normalizedBirthDate = (birth_date ?? birthDate)
      ? String(birth_date ?? birthDate).slice(0, 10)
      : null;
    const normalizedPhone = phone && String(phone).trim() ? String(phone).trim() : null;

    if (!name || !email) {
      res.status(400).json({
        success: false,
        message: 'Nama dan email wajib diisi',
        meta: { timestamp: new Date().toISOString() }
      });
      return;
    }

    const cleanEmail = email.trim().toLowerCase();
    const cleanUsername = username ? String(username).trim().toLowerCase() : null;
    if (cleanUsername) {
      const [existingUsernames]: any = await db.query(
        'SELECT id FROM users WHERE username = ?',
        [cleanUsername]
      );
      if (existingUsernames && existingUsernames.length > 0) {
        res.status(409).json({
          success: false,
          message: 'Username sudah digunakan. Silakan pilih username lain.',
          meta: { timestamp: new Date().toISOString() }
        });
        return;
      }
    }

    // 1. Cek apakah email sudah terdaftar di database
    const [existingUsers]: any = await db.query(
      'SELECT id, name, username, phone, birth_date, gender, email, role, google_id, avatar_url, token_version, two_factor_enabled FROM users WHERE email = ?',
      [cleanEmail]
    );

    if (existingUsers && existingUsers.length > 0) {
      const existing = existingUsers[0];
      if (isGoogle && !existing.google_id) {
        // Tautkan akun Google ke pengguna yang sudah terdaftar
        await db.query(
          'UPDATE users SET google_id = ?, avatar_url = COALESCE(avatar_url, ?), phone = COALESCE(phone, ?), birth_date = COALESCE(birth_date, ?) WHERE id = ?',
          [google_id || null, avatar_url || null, normalizedPhone, normalizedBirthDate, existing.id]
        );
        const { token, refresh_token } = signTokenPair({ id: existing.id, email: cleanEmail, role: existing.role, ver: existing.token_version });
        res.status(200).json({
          success: true,
          message: 'Akun Google berhasil dihubungkan!',
          data: {
            token,
            refresh_token,
            id: existing.id,
            name: existing.name,
            username: existing.username || cleanEmail.split('@')[0],
            phone: existing.phone || normalizedPhone,
            birth_date: existing.birth_date || normalizedBirthDate,
            email: cleanEmail,
            role: existing.role,
            two_factor_enabled: Boolean(existing.two_factor_enabled),
          },
          meta: { timestamp: new Date().toISOString() }
        });
        return;
      }

      res.status(409).json({
        success: false,
        message: 'Email sudah terdaftar. Silakan langsung masuk ke akun Anda.',
        meta: { timestamp: new Date().toISOString() }
      });
      return;
    }

    // 2. Jika pendaftaran lewat Google: langsung aktifkan tanpa OTP
    if (isGoogle) {
      const passwordHash = password ? await bcrypt.hash(password, 10) : null;
      const [result]: any = await db.query(
        'INSERT INTO users (name, username, phone, birth_date, email, password_hash, password_changed_at, role, is_active, google_id, avatar_url) VALUES (?, ?, ?, ?, ?, ?, ?, "pengunjung", 1, ?, ?)',
        [
          name.trim(),
          cleanUsername,
          normalizedPhone,
          normalizedBirthDate,
          cleanEmail,
          passwordHash,
          passwordHash ? new Date() : null,
          google_id || null,
          avatar_url || null,
        ]
      );
      const newUserId = result.insertId;

      const { token, refresh_token } = signTokenPair({ id: newUserId, email: cleanEmail, role: 'pengunjung' });

      res.status(201).json({
        success: true,
        message: 'Pendaftaran pengunjung berhasil!',
        data: {
          token,
          refresh_token,
          id: newUserId,
          name: name.trim(),
          username: cleanUsername || cleanEmail.split('@')[0],
          phone: normalizedPhone,
          birth_date: normalizedBirthDate,
          email: cleanEmail,
          role: 'pengunjung',
          avatar_url: avatar_url || null,
          two_factor_enabled: false,
        },
        meta: { timestamp: new Date().toISOString() }
      });
      return;
    }

    // 3. Jika pendaftaran manual (bukan Google): Wajibkan password dan kirim OTP verifikasi email
    if (!password || password.length < 6) {
      res.status(400).json({
        success: false,
        message: 'Password minimal 6 karakter',
        meta: { timestamp: new Date().toISOString() }
      });
      return;
    }

    const otp = Math.floor(100000 + Math.random() * 900000).toString();
    const expiresAt = Date.now() + 5 * 60 * 1000;

    otpStore.set(cleanEmail, {
      code: otp,
      email: cleanEmail,
      expiresAt,
      verified: false,
      type: 'register',
      data: {
        name: name.trim(),
        username: cleanUsername,
        email: cleanEmail,
        password,
        phone: normalizedPhone,
        birth_date: normalizedBirthDate,
      },
    });

    if (process.env['NODE_ENV'] !== 'production') {
      console.log('\n========================================');
      console.log(`[DEV REGISTER OTP] Kode OTP untuk ${cleanEmail}: ${otp}`);
      console.log('========================================\n');
    }

    try {
      await sendOTPEmail(cleanEmail, otp, name.trim(), 'register');
      console.log(`✅ [OTP EMAIL] Email OTP pendaftaran berhasil terkirim ke ${cleanEmail}`);
    } catch (err: any) {
      console.error('⚠️ [OTP EMAIL] Gagal mengirim email OTP pendaftaran:', err.message);
    }

    res.status(200).json({
      success: true,
      requires_otp: true,
      message: 'Kode OTP verifikasi telah dikirim ke email Anda. Silakan verifikasi untuk menyelesaikan pendaftaran.',
      data: {
        email: cleanEmail,
        requires_otp: true,
      },
      meta: { timestamp: new Date().toISOString() }
    });
    return;
  } catch (error) {
    console.error('Error register customer:', error);
    res.status(500).json({
      success: false,
      message: 'Terjadi kesalahan pada server saat pendaftaran.',
      meta: { timestamp: new Date().toISOString() }
    });
  }
};

export const saveFcmToken = async (req: Request, res: Response): Promise<void> => {
  try {
    const userId = res.locals['userId'];
    const { fcm_token, platform = 'android' } = req.body;

    if (!fcm_token) {
      res.status(400).json({ success: false, message: 'FCM Token wajib dikirim' });
      return;
    }

    await db.query(
      `INSERT INTO user_device_tokens (user_id, fcm_token, platform)
       VALUES (?, ?, ?)
       ON DUPLICATE KEY UPDATE platform = VALUES(platform), updated_at = NOW()`,
      [userId, fcm_token, platform]
    );

    res.status(200).json({ success: true, message: 'FCM token berhasil disinkronkan' });
  } catch (error) {
    console.error('Error save FCM token:', error);
    res.status(500).json({ success: false, message: 'Gagal menyimpan FCM token' });
  }
};

export const registerMitra = async (req: Request, res: Response): Promise<void> => {
  const connection = await db.getConnection();

  try {
    await connection.beginTransaction();

    const { name, email, password, whatsapp_number, store_name, workshop_address, started_year } = req.body;
    const files = req.files as { [fieldname: string]: Express.Multer.File[] };

    if (!name || !email || !whatsapp_number || !store_name || !workshop_address) {
      await connection.rollback();
      res.status(400).json({ success: false, message: 'Semua data teks wajib diisi' });
      return;
    }

    const nameRegex = /^[a-zA-Z\s]+$/;
    if (!nameRegex.test(name.trim())) {
      await connection.rollback();
      res.status(400).json({ success: false, message: 'Format nama tidak valid (hanya huruf dan spasi)' });
      return;
    }

    const phoneRegex = /^[0-9]+$/;
    if (!phoneRegex.test(whatsapp_number.trim())) {
      await connection.rollback();
      res.status(400).json({ success: false, message: 'Nomor HP hanya boleh berisi angka' });
      return;
    }

    if (whatsapp_number.trim().length < 10 || whatsapp_number.trim().length > 14) {
      await connection.rollback();
      res.status(400).json({ success: false, message: 'Nomor HP harus 10-14 digit' });
      return;
    }

    if (!files || !files.ktp_file || !files.nib_file || !files.product_images) {
      await connection.rollback();
      res.status(400).json({ success: false, message: 'File KTP, NIB, dan Foto Produk wajib diunggah' });
      return;
    }

    const cleanRegisterEmail = String(email).trim().toLowerCase();
    const [existingUsers]: any = await connection.query(
      'SELECT id, role, password_hash FROM users WHERE LOWER(TRIM(email)) = ? LIMIT 1',
      [cleanRegisterEmail]
    );
    let newUserId: number;

    if (existingUsers.length > 0) {
      const existingUser = existingUsers[0];
      if (existingUser.role === 'admin') {
        await connection.rollback();
        res.status(403).json({
          success: false,
          message: 'Email administrator tidak dapat didaftarkan sebagai Mitra.',
        });
        return;
      }

      const [existingProfile]: any = await connection.query(
        'SELECT id, ktp_file_url FROM mitra_profiles WHERE user_id = ?',
        [existingUser.id]
      );
      if (existingProfile.length > 0 && existingProfile[0].ktp_file_url) {
        await connection.rollback();
        res.status(409).json({ success: false, message: 'Email sudah terdaftar sebagai Mitra' });
        return;
      }

      if (existingUser.password_hash) {
        const passMatches =
          typeof password === 'string' &&
          password.length > 0 &&
          (await bcrypt.compare(password, existingUser.password_hash));
        if (!passMatches) {
          await connection.rollback();
          res.status(409).json({
            success: false,
            message:
              'Email ini sudah terdaftar sebagai akun pelanggan. Masukkan kata sandi akun Anda yang sesuai untuk mendaftarkan toko Mitra.',
          });
          return;
        }
        newUserId = existingUser.id;
        await connection.query(
          "UPDATE users SET name = ?, role = 'mitra' WHERE id = ?",
          [name.trim(), newUserId]
        );
      } else {
        newUserId = existingUser.id;
        if (password) {
          const passwordHash = await bcrypt.hash(password, 10);
          await connection.query(
            "UPDATE users SET name = ?, password_hash = ?, role = 'mitra' WHERE id = ?",
            [name.trim(), passwordHash, newUserId]
          );
        } else {
          await connection.query(
            "UPDATE users SET name = ?, role = 'mitra' WHERE id = ?",
            [name.trim(), newUserId]
          );
        }
      }
    } else {
      const passwordHash = password ? await bcrypt.hash(password, 10) : null;
      const [userResult]: any = await connection.query(
        'INSERT INTO users (name, email, password_hash, role, is_active) VALUES (?, ?, ?, ?, ?)',
        [name.trim(), cleanRegisterEmail, passwordHash, 'mitra', 1]
      );
      newUserId = userResult.insertId;
    }

    const ktpUrl = getUploadedFileUrl(files.ktp_file[0]) ?? '';
    const nibUrl = getUploadedFileUrl(files.nib_file[0]) ?? '';
    const productImagesUrls = files.product_images
      .map(file => getUploadedFileUrl(file))
      .filter((url): url is string => Boolean(url));

    const [checkProfile]: any = await connection.query('SELECT id FROM mitra_profiles WHERE user_id = ?', [newUserId]);
    if (checkProfile.length > 0) {
      await connection.query(
        `UPDATE mitra_profiles SET 
         whatsapp_number = ?, store_name = ?, workshop_address = ?, started_year = ?, 
         ktp_file_url = ?, nib_file_url = ?, sample_product_images = ?, is_verified = 0, is_active = 1
         WHERE user_id = ?`,
        [
          whatsapp_number,
          store_name,
          workshop_address,
          started_year || null,
          ktpUrl,
          nibUrl,
          JSON.stringify(productImagesUrls),
          newUserId
        ]
      );
    } else {
      await connection.query(
        `INSERT INTO mitra_profiles 
         (user_id, whatsapp_number, store_name, workshop_address, started_year, ktp_file_url, nib_file_url, sample_product_images, is_verified, is_active) 
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, 1)`,
        [
          newUserId,
          whatsapp_number,
          store_name,
          workshop_address,
          started_year || null,
          ktpUrl,
          nibUrl,
          JSON.stringify(productImagesUrls)
        ]
      );
    }

    await connection.commit();

    applyMitraPendingAuthLog(res, {
      userId: newUserId,
      email: String(email).trim().toLowerCase(),
      storeName: store_name,
      ownerName: name,
      isVerified: 0,
      isRegistration: true,
      authMethod: 'password',
    });

    res.status(201).json({
      success: true,
      message: 'Registrasi Mitra berhasil! Menunggu verifikasi admin.',
      meta: {
        timestamp: new Date().toISOString()
      }
    });
    return;

  } catch (error) {
    await connection.rollback();
    console.error('Error register mitra:', error);
    res.status(500).json({
      success: false,
      message: 'Terjadi kesalahan pada server',
      meta: { timestamp: new Date().toISOString() }
    });
    return;
  } finally {
    connection.release();
  }
};

// Login umum yang mendukung peran pengunjung, mitra, dan admin
export const login = async (req: Request, res: Response): Promise<void> => {
  try {
    const { email, password, portal } = req.body;

    if (!email || !password) {
      res.status(400).json({
        success: false,
        message: 'Email dan password wajib diisi',
        meta: { timestamp: new Date().toISOString() }
      });
      return;
    }

    const query = `
      SELECT u.id, u.name, COALESCE(NULLIF(TRIM(u.username), ''), SUBSTRING_INDEX(u.email, '@', 1)) AS username,
             u.phone, u.birth_date, u.gender, u.email, u.password_hash, u.password_changed_at,
             u.role, u.is_active, u.avatar_url, u.token_version, u.two_factor_enabled,
             m.store_name, m.is_verified, m.rejection_reason
      FROM users u 
      LEFT JOIN mitra_profiles m ON u.id = m.user_id 
      WHERE u.email = ?
      LIMIT 1
    `;
    const [users]: any = await db.query(query, [email.trim().toLowerCase()]);

    if (users.length === 0) {
      res.status(401).json({
        success: false,
        message: 'Email atau password salah',
        meta: { timestamp: new Date().toISOString() }
      });
      return;
    }

    const user = users[0];

    if (user.is_active === 0) {
      res.status(403).json({
        success: false,
        message: 'Akun Anda sedang dinonaktifkan.',
        meta: { timestamp: new Date().toISOString() }
      });
      return;
    }

    if (portal === 'web' && user.role === 'pengunjung') {
      res.status(403).json({
        success: false,
        code: 'PENGUNJUNG_ROLE_NOT_ALLOWED_WEB',
        redirect_to_register: true,
        message:
          'Email ini sudah terdaftar sebagai Pengunjung di aplikasi DinoyoCraft dan tidak dapat digunakan untuk masuk di web. Silakan daftar sebagai Mitra terlebih dahulu jika ingin menggunakan akun yang sama.',
        data: {
          email: user.email,
          name: user.name,
          role: user.role,
        },
        meta: { timestamp: new Date().toISOString() }
      });
      return;
    }

    if (!user.password_hash) {
      res.status(400).json({
        success: false,
        message: 'Akun ini terdaftar melalui Google. Silakan masuk menggunakan Google.',
        meta: { timestamp: new Date().toISOString() }
      });
      return;
    }

    const isMatch = await bcrypt.compare(password, user.password_hash);
    if (!isMatch) {
      res.status(401).json({
        success: false,
        message: 'Email atau password salah!',
        meta: { timestamp: new Date().toISOString() }
      });
      return;
    }

    res.locals['userId'] = user.id;
    res.locals['role'] = user.role;

    // Jika Autentikasi 2 Langkah (2FA) aktif di akun pengguna:
    // JANGAN keluarkan JWT terlebih dahulu — kirim OTP 6 digit ke email asli pengguna!
    if (Number(user.two_factor_enabled) === 1) {
      const loginOtp = Math.floor(100000 + Math.random() * 900000).toString();
      await db.query(
        "UPDATE user_otps SET is_used = 1 WHERE user_id = ? AND otp_type = 'login' AND is_used = 0",
        [user.id]
      );
      await db.query(
        "INSERT INTO user_otps (user_id, otp_code, otp_type, expires_at, is_used) VALUES (?, ?, 'login', DATE_ADD(NOW(), INTERVAL 5 MINUTE), 0)",
        [user.id, loginOtp]
      );

      if (process.env['NODE_ENV'] !== 'production') {
        console.log('\n========================================');
        console.log(`[DEV LOGIN 2FA OTP] Kode OTP untuk ${user.email}: ${loginOtp}`);
        console.log('========================================\n');
      }

      try {
        await sendOTPEmail(user.email, loginOtp, user.name, 'login');
      } catch (mailErr: any) {
        console.error('⚠️ [LOGIN 2FA EMAIL] Gagal mengirim email OTP login:', mailErr.message);
      }

      res.locals['logCategory'] = 'auth';
      res.locals['logEventName'] = 'auth.login.2fa_pending';
      res.locals['logSeverity'] = 'info';
      res.locals['logOutcome'] = 'pending';
      res.locals['logMessage'] = `Login akun ${user.role} (${user.email}) menunggu verifikasi kode OTP 2FA (PENDING)`;

      res.status(200).json({
        success: true,
        requires_2fa: true,
        message: 'Kode OTP verifikasi masuk telah dikirim ke email terdaftar Anda.',
        data: {
          requires_2fa: true,
          email: user.email,
        },
        meta: { timestamp: new Date().toISOString() },
      });
      return;
    }

    const { token, refresh_token } = signTokenPair({ id: user.id, email: user.email, role: user.role, ver: user.token_version });

    if (user.role === 'mitra' && Number(user.is_verified) !== 1) {
      applyMitraPendingAuthLog(res, {
        userId: user.id,
        email: user.email,
        storeName: user.store_name,
        ownerName: user.name,
        isVerified: user.is_verified,
        rejectionReason: user.rejection_reason,
        authMethod: 'password',
      });
    } else {
      res.locals['logCategory'] = 'auth';
      res.locals['logEventName'] = 'auth.login.succeeded';
      res.locals['logSeverity'] = 'success';
      res.locals['logOutcome'] = 'success';
      res.locals['logMessage'] = `Login berhasil untuk akun ${user.role} (${user.email})`;
      res.locals['logMetadata'] = {
        email: user.email,
        role: user.role,
        storeName: user.store_name || null,
        authMethod: 'password',
      };
    }

    res.cookie('token', token, {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'lax',
      maxAge: 24 * 60 * 60 * 1000
    });

    res.status(200).json({
      success: true,
      message: 'Login berhasil!',
      data: {
        token: token,
        refresh_token: refresh_token,
        id: user.id,
        name: user.name,
        username: user.username,
        phone: user.phone,
        birth_date: user.birth_date,
        gender: user.gender,
        email: user.email,
        role: user.role,
        avatar_url: user.avatar_url,
        two_factor_enabled: false,
        password_changed_at: user.password_changed_at,
        has_password: true,
        store_name: user.store_name,
        is_verified: user.is_verified,
        rejection_reason: user.rejection_reason
      },
      meta: {
        timestamp: new Date().toISOString()
      }
    });
    return;
  } catch (error) {
    console.error('Error login:', error);
    res.status(500).json({
      success: false,
      message: 'Terjadi kesalahan pada server.',
      meta: { timestamp: new Date().toISOString() }
    });
    return;
  }
};

export const loginMitra = async (req: Request, res: Response): Promise<void> => {
  try {
    const { email, password } = req.body;

    if (!email || !password) {
      res.status(400).json({
        success: false,
        message: 'Email dan password wajib diisi',
        meta: { timestamp: new Date().toISOString() }
      });
      return;
    }

    const query = `
      SELECT u.id, u.name, u.email, u.password_hash, u.role, u.is_active, u.token_version,
             m.store_name, m.is_verified, m.rejection_reason
      FROM users u 
      LEFT JOIN mitra_profiles m ON u.id = m.user_id 
      WHERE u.email = ?
    `;
    const [users]: any = await db.query(query, [email.trim().toLowerCase()]);

    if (users.length === 0) {
      res.status(401).json({
        success: false,
        message: 'Email atau password salah',
        meta: { timestamp: new Date().toISOString() }
      });
      return;
    }

    const user = users[0];

    if (user.role === 'pengunjung') {
      res.status(403).json({
        success: false,
        code: 'PENGUNJUNG_ROLE_NOT_ALLOWED_WEB',
        redirect_to_register: true,
        message:
          'Email ini sudah terdaftar sebagai Pengunjung di aplikasi DinoyoCraft dan tidak dapat digunakan untuk masuk di web. Silakan daftar sebagai Mitra terlebih dahulu jika ingin menggunakan akun yang sama.',
        data: {
          email: user.email,
          name: user.name,
          role: user.role,
        },
        meta: { timestamp: new Date().toISOString() }
      });
      return;
    }

    if (user.role !== 'mitra' && user.role !== 'admin') {
      res.status(403).json({
        success: false,
        message: 'Akses ditolak. Akun ini bukan akun Mitra.',
        meta: { timestamp: new Date().toISOString() }
      });
      return;
    }

    if (user.is_active === 0) {
      res.status(403).json({
        success: false,
        message: 'Akun Anda sedang dinonaktifkan.',
        meta: { timestamp: new Date().toISOString() }
      });
      return;
    }

    if (!user.password_hash) {
      res.status(400).json({
        success: false,
        message: 'Akun ini terdaftar melalui Google. Silakan masuk menggunakan Google.',
        meta: { timestamp: new Date().toISOString() }
      });
      return;
    }

    const isMatch = await bcrypt.compare(password, user.password_hash);
    if (!isMatch) {
      res.status(401).json({
        success: false,
        message: 'Email atau password salah!',
        meta: { timestamp: new Date().toISOString() }
      });
      return;
    }

    const { token, refresh_token } = signTokenPair({ id: user.id, email: user.email, role: user.role, ver: user.token_version });

    res.locals['userId'] = user.id;
    res.locals['role'] = user.role;
    if (user.role === 'mitra' && Number(user.is_verified) !== 1) {
      applyMitraPendingAuthLog(res, {
        userId: user.id,
        email: user.email,
        storeName: user.store_name,
        ownerName: user.name,
        isVerified: user.is_verified,
        rejectionReason: user.rejection_reason,
        authMethod: 'password',
      });
    } else {
      res.locals['logCategory'] = 'auth';
      res.locals['logEventName'] = 'auth.login.succeeded';
      res.locals['logSeverity'] = 'success';
      res.locals['logOutcome'] = 'success';
      res.locals['logMessage'] = `Login Mitra "${user.store_name || user.name}" (${user.email}) berhasil`;
    }

    res.cookie('token', token, {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'lax',
      maxAge: 24 * 60 * 60 * 1000
    });

    res.status(200).json({
      success: true,
      message: 'Login berhasil!',
      data: {
        token: token,
        refresh_token: refresh_token,
        id: user.id,
        name: user.name,
        email: user.email,
        role: user.role,
        store_name: user.store_name,
        is_verified: user.is_verified,
        rejection_reason: user.rejection_reason
      },
      meta: {
        timestamp: new Date().toISOString()
      }
    });
    return;
  } catch (error) {
    console.error('Error login mitra:', error);
    res.status(500).json({
      success: false,
      message: 'Terjadi kesalahan pada server.',
      meta: { timestamp: new Date().toISOString() }
    });
    return;
  }
};

export const googleLogin = async (req: Request, res: Response): Promise<void> => {
  try {
    const {
      credential,
      id_token,
      token: tokenParam,
      access_token,
      userInfo,
      is_register,
      action,
      role = 'pengunjung',
      portal,
      phone,
    } = req.body;
    const tokenToVerify = credential || id_token || tokenParam;
    const oauthAccessToken = typeof access_token === 'string' ? access_token.trim() : '';

    if (!tokenToVerify && !oauthAccessToken && !userInfo) {
      res.status(400).json({ success: false, message: 'Data otentikasi Google wajib dikirim' });
      return;
    }

    let email = '';
    let name = '';
    let googleId = '';
    let avatarUrl: string | null = null;
    let googleVerified = false;

    if (tokenToVerify) {
      try {
        const client = new OAuth2Client();
        const validAudiences: string[] = [
          process.env['GOOGLE_CLIENT_ID'],
          process.env['GOOGLE_CLIENT_ID_WEB'],
          process.env['GOOGLE_CLIENT_ID_MOBILE'],
          process.env['GOOGLE_CLIENT_ID_ALT'],
          '379734738528-dc5htqtqu1k8qn5khubul347aghuka6r.apps.googleusercontent.com'
        ].filter((id): id is string => Boolean(id && typeof id === 'string' && id.trim().length > 0));

        const ticket = await client.verifyIdToken({
          idToken: tokenToVerify,
          audience: validAudiences.length > 0 ? validAudiences : undefined,
        });
        const payload = ticket.getPayload();
        if (payload && payload.email) {
          email = payload.email;
          name = payload.name || payload.given_name || 'Pengguna Google';
          googleId = payload.sub;
          avatarUrl = payload.picture || null;
          googleVerified = true;
        }
      } catch (verifyError) {
        console.warn('Google verifyIdToken failed:', verifyError);
        res.status(401).json({
          success: false,
          message: 'Token Google tidak valid atau telah kedaluwarsa.',
        });
        return;
      }
    } else if (oauthAccessToken) {
      try {
        const gRes = await fetch('https://www.googleapis.com/oauth2/v3/userinfo', {
          headers: { Authorization: `Bearer ${oauthAccessToken}` },
        });
        if (!gRes.ok) {
          res.status(401).json({
            success: false,
            message: 'Akses token Google tidak valid atau telah kedaluwarsa.',
          });
          return;
        }
        const gData = (await gRes.json()) as Record<string, any>;
        if (gData && gData['email']) {
          email = String(gData['email']);
          name = String(gData['name'] || gData['given_name'] || 'Pengguna Google');
          googleId = String(gData['sub'] || gData['id'] || '');
          avatarUrl = gData['picture'] ? String(gData['picture']) : null;
          googleVerified = true;
        }
      } catch (oauthErr) {
        console.warn('Google userinfo verification failed:', oauthErr);
        res.status(401).json({
          success: false,
          message: 'Gagal memverifikasi akses token Google.',
        });
        return;
      }
    } else if (process.env['NODE_ENV'] !== 'production' && userInfo && userInfo.email) {
      email = String(userInfo.email);
      name = String(userInfo.name || 'Pengguna Google');
      googleId = String(userInfo.sub || userInfo.id || '');
      avatarUrl = userInfo.picture ? String(userInfo.picture) : null;
      googleVerified = false;
    } else {
      res.status(401).json({
        success: false,
        message: 'Token Google terverifikasi wajib disertakan.',
      });
      return;
    }

    if (!email) {
      res.status(400).json({ success: false, message: 'Gagal mendapatkan data akun dari Google' });
      return;
    }

    const query = `
      SELECT u.id, u.name, COALESCE(NULLIF(TRIM(u.username), ''), SUBSTRING_INDEX(u.email, '@', 1)) AS username,
             u.phone, u.birth_date, u.gender, u.email, u.role, u.is_active, u.google_id, u.avatar_url,
             u.token_version, u.two_factor_enabled, u.password_changed_at,
             (u.password_hash IS NOT NULL AND u.password_hash != '') AS has_password,
             m.store_name, m.is_verified, m.rejection_reason
      FROM users u 
      LEFT JOIN mitra_profiles m ON u.id = m.user_id 
      WHERE (u.google_id IS NOT NULL AND u.google_id = ?) OR u.email = ?
      LIMIT 1
    `;
    const [users]: any = await db.query(query, [googleId || 'NON_EXISTENT_ID', email.trim().toLowerCase()]);

    let user;

    if (users.length > 0) {
      user = users[0];

      if (user.is_active === 0) {
        res.status(403).json({ success: false, message: 'Akun Anda sedang dinonaktifkan.' });
        return;
      }

      if (portal === 'web' && user.role === 'pengunjung') {
        res.status(403).json({
          success: false,
          code: 'PENGUNJUNG_ROLE_NOT_ALLOWED_WEB',
          redirect_to_register: true,
          message:
            'Akun Google ini sudah terdaftar sebagai Pengunjung di aplikasi DinoyoCraft dan tidak dapat digunakan untuk masuk di web. Silakan daftar sebagai Mitra terlebih dahulu jika ingin menggunakan akun yang sama.',
          data: {
            email: user.email,
            name: user.name,
            role: user.role,
          },
          meta: { timestamp: new Date().toISOString() },
        });
        return;
      }

      if (user.role !== 'mitra' && user.role !== 'admin' && user.role !== 'pengunjung') {
        res.status(403).json({ success: false, message: 'Akses ditolak. Peran pengguna tidak diizinkan.' });
        return;
      }

      if (user.role === 'admin' && !googleVerified) {
        res.status(401).json({
          success: false,
          message: 'Akun admin wajib masuk menggunakan token Google terverifikasi.',
        });
        return;
      }

      if (!user.google_id || !user.avatar_url) {
        await db.query(
          'UPDATE users SET google_id = COALESCE(google_id, ?), avatar_url = COALESCE(avatar_url, ?) WHERE id = ?',
          [googleId || null, avatarUrl || null, user.id]
        );
      }

      // Jika akun telah mengaktifkan 2FA, kirim OTP Login ke email aslinya
      if (Number(user.two_factor_enabled) === 1) {
        const loginOtp = Math.floor(100000 + Math.random() * 900000).toString();
        await db.query(
          "UPDATE user_otps SET is_used = 1 WHERE user_id = ? AND otp_type = 'login' AND is_used = 0",
          [user.id]
        );
        await db.query(
          "INSERT INTO user_otps (user_id, otp_code, otp_type, expires_at, is_used) VALUES (?, ?, 'login', DATE_ADD(NOW(), INTERVAL 5 MINUTE), 0)",
          [user.id, loginOtp]
        );
        try {
          await sendOTPEmail(user.email, loginOtp, user.name, 'login');
        } catch (mailErr: any) {
          console.error('⚠️ [GOOGLE LOGIN 2FA EMAIL] Gagal kirim OTP:', mailErr.message);
        }
        res.locals['userId'] = user.id;
        res.locals['role'] = user.role;
        res.locals['logCategory'] = 'auth';
        res.locals['logEventName'] = 'auth.login.2fa_pending';
        res.locals['logSeverity'] = 'info';
        res.locals['logOutcome'] = 'pending';
        res.locals['logMessage'] = `Login Google (${user.email}) menunggu verifikasi kode OTP 2FA (PENDING)`;
        res.status(200).json({
          success: true,
          is_registered: true,
          requires_2fa: true,
          message: 'Kode OTP verifikasi masuk telah dikirim ke email terdaftar Anda.',
          data: {
            requires_2fa: true,
            email: user.email,
          },
          meta: { timestamp: new Date().toISOString() },
        });
        return;
      }
    } else {
      // Akun Google BELUM terdaftar di database
      const isRegisterIntent = Boolean(is_register === true || action === 'register');

      if (!isRegisterIntent) {
        // Alur Login: JANGAN buat akun otomatis. Berikan sinyal 404 & is_registered: false
        res.status(404).json({
          success: false,
          is_registered: false,
          message: 'Akun Google belum terdaftar. Silakan lakukan pendaftaran terlebih dahulu.',
          data: {
            email: email.trim().toLowerCase(),
            name,
            avatar_url: avatarUrl,
            google_id: googleId,
          },
          meta: { timestamp: new Date().toISOString() }
        });
        return;
      }

      // Alur Register: Daftarkan pengguna baru dengan aman
      const connection = await db.getConnection();
      try {
        await connection.beginTransaction();

        const targetRole = (role === 'pengunjung') ? 'pengunjung' : 'mitra';
        const cleanPhone = phone && String(phone).trim() ? String(phone).trim() : null;
        const [insertUser]: any = await connection.query(
          'INSERT INTO users (name, phone, email, password_hash, role, is_active, google_id, avatar_url) VALUES (?, ?, ?, NULL, ?, 1, ?, ?)',
          [name, cleanPhone, email.trim().toLowerCase(), targetRole, googleId || null, avatarUrl || null]
        );
        const newUserId = insertUser.insertId;

        if (targetRole === 'mitra') {
          await connection.query(
            `INSERT INTO mitra_profiles 
             (user_id, whatsapp_number, store_name, workshop_address, started_year, ktp_file_url, nib_file_url, sample_product_images, is_verified, is_active) 
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, 1)`,
            [
              newUserId,
              cleanPhone || '-',
              'Toko ' + name,
              '-',
              new Date().getFullYear(),
              '',
              '',
              '[]'
            ]
          );
        }

        await connection.commit();

        user = {
          id: newUserId,
          name,
          username: email.trim().toLowerCase().split('@')[0],
          phone: cleanPhone,
          email: email.trim().toLowerCase(),
          role: targetRole,
          store_name: targetRole === 'mitra' ? ('Toko ' + name) : undefined,
          is_verified: targetRole === 'mitra' ? 0 : 1,
          avatar_url: avatarUrl,
          two_factor_enabled: 0,
          has_password: 0,
        };
      } catch (insertErr) {
        await connection.rollback();
        throw insertErr;
      } finally {
        connection.release();
      }
    }

    const { token, refresh_token } = signTokenPair({ id: user.id, email: user.email, role: user.role, ver: user.token_version });

    res.locals['userId'] = user.id;
    res.locals['role'] = user.role;
    if (user.role === 'mitra' && Number(user.is_verified) !== 1) {
      applyMitraPendingAuthLog(res, {
        userId: user.id,
        email: user.email,
        storeName: user.store_name,
        ownerName: user.name,
        isVerified: user.is_verified,
        rejectionReason: user.rejection_reason,
        isRegistration: users.length === 0,
        authMethod: 'google',
      });
    } else {
      res.locals['logCategory'] = 'auth';
      res.locals['logEventName'] =
        users.length > 0 ? 'auth.google_login.succeeded' : 'auth.google_register.succeeded';
      res.locals['logSeverity'] = 'success';
      res.locals['logOutcome'] = 'success';
      res.locals['logMessage'] = `${users.length > 0 ? 'Login' : 'Pendaftaran'} Google berhasil untuk akun ${user.role} (${user.email})`;
    }

    res.cookie('token', token, {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'lax',
      maxAge: 24 * 60 * 60 * 1000
    });

    res.status(200).json({
      success: true,
      is_registered: true,
      message: users.length > 0 ? 'Login dengan Google berhasil!' : 'Pendaftaran dengan Google berhasil!',
      token,
      data: {
        token,
        refresh_token,
        id: user.id,
        name: user.name,
        username: user.username,
        phone: user.phone,
        birth_date: user.birth_date || null,
        gender: user.gender || null,
        email: user.email,
        role: user.role,
        two_factor_enabled: Boolean(user.two_factor_enabled),
        has_password: Boolean(user.has_password),
        store_name: user.store_name,
        is_verified: user.is_verified,
        rejection_reason: user.rejection_reason,
        avatar_url: user.avatar_url || avatarUrl
      },
      meta: { timestamp: new Date().toISOString() }
    });
    return;

  } catch (error) {
    console.error('Error google login:', error);
    res.status(500).json({ success: false, message: 'Terjadi kesalahan pada server saat otentikasi Google' });
    return;
  }
};

export const getProfile = async (_req: Request, res: Response) => {
  try {
    const userId = res.locals['userId'];
    if (!userId) return res.status(401).json({ success: false, message: 'Unauthorized' });

    const [rows]: any = await db.query(
      `SELECT u.id, u.name, u.email, u.role, u.avatar_url,
              u.phone, u.birth_date, u.gender,
              u.two_factor_enabled, u.password_changed_at, u.google_id,
              (u.password_hash IS NOT NULL AND u.password_hash != '') AS has_password,
              COALESCE(NULLIF(TRIM(u.username), ''), SUBSTRING_INDEX(u.email, '@', 1)) AS username,
              m.store_name, m.whatsapp_number, m.workshop_address, 
              m.started_year, m.description, m.website, m.instagram, 
              m.banner_url, m.is_verified, m.rejection_reason,
              m.ktp_file_url, m.nib_file_url, m.sample_product_images
       FROM users u
       LEFT JOIN mitra_profiles m ON u.id = m.user_id
       WHERE u.id = ?`,
      [userId]
    );

    if (!rows || rows.length === 0) {
      return res.status(404).json({ success: false, message: 'User tidak ditemukan' });
    }

    const profile = rows[0];
    return res.status(200).json({
      success: true,
      data: {
        ...profile,
        two_factor_enabled: Boolean(profile.two_factor_enabled),
        has_password: Boolean(profile.has_password),
      },
    });
  } catch (error) {
    console.error('Error getProfile:', error);
    return res.status(500).json({ success: false, message: 'Terjadi kesalahan server' });
  }
};

export const updateProfile = async (req: Request, res: Response) => {
  try {
    const userId = res.locals['userId'];
    if (!userId) return res.status(401).json({ success: false, message: 'Unauthorized' });

    const ownerName = req.body.ownerName ?? req.body.nama ?? req.body.name;
    const rawUsername = req.body.username !== undefined ? String(req.body.username).trim().toLowerCase() : null;
    const storeName = req.body.storeName ?? req.body.nama_toko;
    const phone = req.body.phone ?? req.body.whatsapp_number;
    const address = req.body.address ?? req.body.alamat ?? req.body.workshop_address;
    const yearStarted = req.body.yearStarted ?? req.body.tahun_mulai ?? req.body.started_year;
    const description = req.body.description ?? req.body.deskripsi;
    const website = req.body.website;
    const instagram = req.body.instagram;

    if (rawUsername && rawUsername.length > 0) {
      if (!/^[a-z0-9_]{3,30}$/.test(rawUsername)) {
        return res.status(400).json({
          success: false,
          message: 'Username harus 3-30 karakter dan hanya boleh berisi huruf, angka, atau garis bawah (_).',
        });
      }
      const [existingUn]: any = await db.query(
        'SELECT id FROM users WHERE username = ? AND id != ? LIMIT 1',
        [rawUsername, userId]
      );
      if (existingUn && existingUn.length > 0) {
        return res.status(409).json({
          success: false,
          message: 'Username sudah dipakai oleh pengguna lain.',
        });
      }
    }

    const files = req.files as { [fieldname: string]: Express.Multer.File[] } | undefined;

    const avatarPath = getUploadedFileUrl(files?.['avatar']?.[0]);
    const bannerPath = getUploadedFileUrl(files?.['banner']?.[0]);
    const birthDate = req.body.birthDate ?? req.body.birth_date ?? null;
    const gender = req.body.gender ?? null;

    // Update data akun di tabel users (semua role)
    await db.query(
      `UPDATE users 
       SET name = COALESCE(?, name),
           username = COALESCE(?, username),
           avatar_url = COALESCE(?, avatar_url),
           phone = COALESCE(?, phone),
           birth_date = COALESCE(?, birth_date),
           gender = COALESCE(?, gender)
       WHERE id = ?`,
      [
        ownerName ? String(ownerName).trim() : null,
        rawUsername && rawUsername.length > 0 ? rawUsername : null,
        avatarPath,
        phone ? String(phone).trim() : null,
        birthDate ? String(birthDate).slice(0, 10) : null,
        ['L', 'P'].includes(gender) ? gender : null,
        userId
      ]
    );

    const [roleRows]: any = await db.query('SELECT role FROM users WHERE id = ?', [userId]);
    const userRole = roleRows?.[0]?.role;

    // Perilaku mitra: profil toko ikut diperbarui. Customer (pengunjung)
    // maupun admin TIDAK boleh membuat baris mitra_profiles palsu.
    if (userRole === 'pengunjung' || userRole === 'admin') {
      const [rows2]: any = await db.query(
        `SELECT u.id, u.name,
                COALESCE(NULLIF(TRIM(u.username), ''), SUBSTRING_INDEX(u.email, '@', 1)) AS username,
                u.email, u.role, u.avatar_url,
                u.phone, u.birth_date, u.gender,
                u.two_factor_enabled, u.password_changed_at,
                (u.password_hash IS NOT NULL AND u.password_hash != '') AS has_password
         FROM users u WHERE u.id = ?`,
        [userId]
      );

      const p = rows2 && rows2.length > 0 ? rows2[0] : null;
      return res.status(200).json({
        success: true,
        message: 'Profil berhasil diperbarui',
        data: p
          ? {
            ...p,
            two_factor_enabled: Boolean(p.two_factor_enabled),
            has_password: Boolean(p.has_password),
          }
          : null,
      });
    }

    // Periksa apakah profil mitra sudah ada di tabel mitra_profiles
    const [checkProfile]: any = await db.query('SELECT id FROM mitra_profiles WHERE user_id = ?', [userId]);

    if (checkProfile && checkProfile.length > 0) {
      // Update profil mitra di tabel mitra_profiles
      await db.query(
        `UPDATE mitra_profiles 
         SET store_name = COALESCE(?, store_name), 
             whatsapp_number = COALESCE(?, whatsapp_number), 
             workshop_address = COALESCE(?, workshop_address), 
             started_year = COALESCE(?, started_year),
             description = COALESCE(?, description), 
             website = COALESCE(?, website), 
             instagram = COALESCE(?, instagram),
             avatar_url = COALESCE(?, avatar_url),
             banner_url = COALESCE(?, banner_url)
         WHERE user_id = ?`,
        [
          storeName ?? null,
          phone ?? null,
          address ?? null,
          yearStarted ? parseInt(String(yearStarted), 10) : null,
          description ?? null,
          website ?? null,
          instagram ?? null,
          avatarPath,
          bannerPath,
          userId
        ]
      );
    } else {
      // Buat baru jika belum ada
      await db.query(
        `INSERT INTO mitra_profiles 
         (user_id, store_name, whatsapp_number, workshop_address, started_year, description, website, instagram, banner_url, is_verified, is_active) 
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)`,
        [
          userId,
          storeName ?? null,
          phone ?? null,
          address ?? null,
          yearStarted ? parseInt(String(yearStarted), 10) : null,
          description ?? null,
          website ?? null,
          instagram ?? null,
          bannerPath,
          userRole === 'admin' ? 1 : 0
        ]
      );
    }

    // Ambil data profil terbaru
    const [rows]: any = await db.query(
      `SELECT u.id, u.name, u.username, u.email, u.role, u.avatar_url,
              u.phone, u.birth_date, u.gender,
              m.store_name, m.whatsapp_number, m.workshop_address, 
              m.started_year, m.description, m.website, m.instagram, 
              m.banner_url, m.is_verified
       FROM users u
       LEFT JOIN mitra_profiles m ON u.id = m.user_id
       WHERE u.id = ?`,
      [userId]
    );

    if (userRole === 'mitra' && rows?.[0] && Number(rows[0].is_verified) !== 1) {
      res.locals['logCategory'] = 'product_store';
      res.locals['logEventName'] = 'mitra.profile.updated_pending_verification';
      res.locals['logSeverity'] = 'info';
      res.locals['logOutcome'] = 'pending';
      res.locals['logMessage'] = `Mitra "${rows[0].store_name || rows[0].name}" memperbarui profil toko — masih menunggu verifikasi Admin (PENDING)`;
      res.locals['logMetadata'] = {
        storeName: rows[0].store_name || null,
        isVerified: Number(rows[0].is_verified ?? 0),
        verificationStatus: 'pending_approval',
      };
    }

    return res.status(200).json({
      success: true,
      message: 'Profil berhasil diperbarui',
      data: rows && rows.length > 0 ? rows[0] : null
    });
  } catch (error) {
    console.error('Error updateProfile:', error);
    return res.status(500).json({ success: false, message: 'Gagal memperbarui profil' });
  }
};

// ============================================================
// Ã°Å¸â€â€˜ OTP Store (In-Memory) Ã¢â‚¬â€ Simpan OTP sementara
// ============================================================
interface OtpEntry {
  code: string;
  email: string;
  expiresAt: number;
  verified: boolean;
  type?: 'register' | 'reset_password' | 'login';
  data?: any;
}

const otpStore = new Map<string, OtpEntry>();

// Bersihkan OTP expired setiap 10 menit
setInterval(() => {
  const now = Date.now();
  for (const [key, entry] of otpStore.entries()) {
    if (now > entry.expiresAt) {
      otpStore.delete(key);
    }
  }
}, 10 * 60 * 1000);





// ============================================================
// FORGOT PASSWORD Ã¢â‚¬â€ Kirim OTP ke email user
// ============================================================
export const forgotPassword = async (req: Request, res: Response): Promise<void> => {
  try {
    const { email } = req.body;

    if (!email) {
      res.status(400).json({ success: false, message: 'Email wajib diisi' });
      return;
    }

    const cleanEmail = email.trim().toLowerCase();

    // 1. Cek apakah user ada di database
    const [users]: any = await db.query('SELECT id, name, email FROM users WHERE LOWER(TRIM(email)) = ?', [cleanEmail]);
    if (!users || users.length === 0) {
      res.status(404).json({ success: false, message: 'Akun dengan email tersebut tidak ditemukan.' });
      return;
    }

    const user = users[0];

    // 2. Buat Kode OTP 6 Digit Angka
    const otp = Math.floor(100000 + Math.random() * 900000).toString();

    // 3. Simpan OTP ke memory (otpStore) agar bisa dicek oleh fungsi resetPassword nanti
    const expiresAt = Date.now() + 5 * 60 * 1000; // Kadaluarsa dalam 5 menit
    otpStore.set(cleanEmail, { code: otp, email: cleanEmail, verified: false, expiresAt });

    try {
      const expiresDate = new Date(Date.now() + 5 * 60 * 1000);
      await db.query(
        'INSERT INTO user_otps (user_id, otp_code, otp_type, expires_at, is_used) VALUES (?, ?, ?, ?, 0)',
        [user.id, otp, 'reset_password', expiresDate]
      );
    } catch (otpErr) {
      console.warn('⚠️ Gagal menyimpan OTP ke database (fallback memory tetap aktif):', otpErr);
    }

    // 4. Print ke terminal hanya saat non-production
    if (process.env['NODE_ENV'] !== 'production') {
      console.log(`\n========================================`);
      console.log(`[DEV OTP] Kode OTP untuk ${cleanEmail}: ${otp}`);
      console.log(`========================================\n`);
    }

    // 5. Kirim OTP via Email dengan Template Branded DinoyoCraft & Logo Project
    const logoUrl =
      'https://raw.githubusercontent.com/alifarda126/DinoyoCraftApp/main/assets/images/branding/Logo.png';

    const mailOptions = {
      from: getDefaultFromAddress(),
      to: cleanEmail,
      subject: 'Kode OTP Verifikasi Lupa Kata Sandi - DinoyoCraft',
      html: `
        <!DOCTYPE html>
        <html lang="id">
        <head>
          <meta charset="UTF-8">
          <meta name="viewport" content="width=device-width, initial-scale=1.0">
          <title>Kode OTP DinoyoCraft</title>
        </head>
        <body style="margin: 0; padding: 0; background-color: #F8F6F2; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; -webkit-font-smoothing: antialiased;">
          <table role="presentation" border="0" cellpadding="0" cellspacing="0" width="100%" style="background-color: #F8F6F2; padding: 40px 15px;">
            <tr>
              <td align="center">
                <table role="presentation" border="0" cellpadding="0" cellspacing="0" width="100%" style="max-width: 540px; background-color: #FFFFFF; border-radius: 20px; overflow: hidden; box-shadow: 0 10px 30px rgba(184, 92, 60, 0.08); border: 1px solid #ECE3DA;">
                  
                  <!-- Top Accent Banner -->
                  <tr>
                    <td style="background: linear-gradient(135deg, #B85C3C 0%, #8C4328 100%); height: 8px;"></td>
                  </tr>

                  <!-- Card Content -->
                  <tr>
                    <td style="padding: 40px 36px 36px;">
                      
                      <!-- Brand Header with Logo -->
                      <table role="presentation" border="0" cellpadding="0" cellspacing="0" width="100%" style="margin-bottom: 24px;">
                        <tr>
                          <td align="center">
                            <table role="presentation" border="0" cellpadding="0" cellspacing="0" style="margin: 0 auto 12px;">
                              <tr>
                                <td align="center" style="width: 76px; height: 76px; padding: 0;">
                                  <img src="${logoUrl}" alt="DinoyoCraft Logo" width="76" height="76" style="width: 76px; height: 76px; object-fit: contain; display: block; border: 0;" />
                                </td>
                              </tr>
                            </table>
                            <h1 style="margin: 0; font-size: 24px; font-weight: 800; color: #2D2A26; letter-spacing: -0.03em;">DinoyoCraft</h1>
                            <p style="margin: 4px 0 0; font-size: 12px; font-weight: 700; color: #B85C3C; letter-spacing: 0.08em; text-transform: uppercase;">Sentra Kerajinan Keramik Dinoyo Malang</p>
                          </td>
                        </tr>
                      </table>

                      <div style="height: 1px; background-color: #ECE3DA; margin-bottom: 24px;"></div>

                      <!-- Content Body -->
                      <table role="presentation" border="0" cellpadding="0" cellspacing="0" width="100%">
                        <tr>
                          <td style="color: #4A4641; font-size: 15px; line-height: 1.65;">
                            <p style="margin: 0 0 14px; font-size: 17px; font-weight: 700; color: #2D2A26;">
                              Permintaan Reset Kata Sandi
                            </p>
                            <p style="margin: 0 0 10px;">
                              Halo <strong style="color: #2D2A26;">${user.name}</strong>,
                            </p>
                            <p style="margin: 0 0 20px; color: #66615B; font-size: 14.5px;">
                              Kami menerima permintaan untuk mengatur ulang kata sandi akun DinoyoCraft Anda. Masukkan kode One-Time Password (OTP) berikut untuk menyelesaikan verifikasi:
                            </p>
                          </td>
                        </tr>

                        <!-- OTP Box -->
                        <tr>
                          <td align="center">
                            <div style="background: linear-gradient(135deg, #FFF9F6 0%, #FDF3EB 100%); border: 2px dashed #B85C3C; border-radius: 16px; padding: 22px 16px; margin: 0 auto 24px; text-align: center;">
                              <span style="display: block; font-size: 11px; font-weight: 700; letter-spacing: 0.12em; color: #8C4328; text-transform: uppercase; margin-bottom: 8px;">
                                Kode Verifikasi OTP Anda
                              </span>
                              <div style="font-family: 'Courier New', Courier, monospace; font-size: 38px; font-weight: 900; letter-spacing: 10px; color: #B85C3C; text-indent: 10px; padding: 4px 0;">
                                ${otp}
                              </div>
                              <div style="margin-top: 10px;">
                                <span style="display: inline-block; background: #FEE2E2; color: #DC2626; padding: 4px 14px; border-radius: 999px; font-size: 12px; font-weight: 600;">
                                  ⏱️ Berlaku selama 5 menit
                                </span>
                              </div>
                            </div>
                          </td>
                        </tr>

                        <!-- Security Notice Box -->
                        <tr>
                          <td>
                            <div style="background-color: #FAF8F5; border-left: 4px solid #B85C3C; border-radius: 0 10px 10px 0; padding: 14px 16px; margin-bottom: 28px;">
                              <p style="margin: 0 0 6px; font-size: 13px; font-weight: 700; color: #2D2A26;">
                                🛡️ Catatan Keamanan:
                              </p>
                              <p style="margin: 0; font-size: 12.5px; color: #706B65; line-height: 1.55;">
                                &bull; Jangan pernah membagikan kode OTP ini kepada siapa pun, termasuk pihak yang mengatasnamakan DinoyoCraft.<br/>
                                &bull; Jika Anda tidak meminta reset kata sandi, abaikan email ini. Kata sandi akun Anda tetap aman tanpa perubahan.
                              </p>
                            </div>
                          </td>
                        </tr>

                        <!-- Support & Closing -->
                        <tr>
                          <td style="border-top: 1px solid #ECE3DA; padding-top: 24px; text-align: center;">
                            <p style="margin: 0 0 6px; font-size: 12px; color: #8A7968;">
                              Butuh bantuan? Hubungi Tim Dukungan DinoyoCraft di <a href="mailto:csdinoyocraft@gmail.com" style="color: #B85C3C; font-weight: 600; text-decoration: none;">csdinoyocraft@gmail.com</a>
                            </p>
                            <p style="margin: 0; font-size: 11px; color: #A89B8C; line-height: 1.5;">
                              Sentra Kerajinan Keramik Dinoyo, Kota Malang, Jawa Timur<br/>
                              &copy; ${new Date().getFullYear()} DinoyoCraft. Hak Cipta Dilindungi.
                            </p>
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

    // Kirim jika konfigurasi email (Resend API atau SMTP) terisi
    if (isEmailConfigured()) {
      try {
        await sendEmail(mailOptions);
        console.log(`✅ [OTP] Email OTP berhasil dikirim ke ${cleanEmail}`);
      } catch (mailError) {
        console.error('⚠️ [OTP] Gagal mengirim email OTP:', mailError);
      }
    } else {
      console.log('⚠️ [OTP] Layanan email (RESEND_API_KEY / SMTP) belum dikonfigurasi.');
    }

    res.status(200).json({
      success: true,
      message: `Kode OTP verifikasi telah dikirimkan ke email ${cleanEmail}`,
    });
    return;
  } catch (error: any) {
    console.error('Error forgot password:', error);
    res.status(500).json({ success: false, message: 'Terjadi kesalahan pada server saat mengirim email' });
    return;
  }
};

// ============================================================
// VERIFY OTP Ã¢â‚¬â€ Validasi kode OTP yang dimasukkan user
// ============================================================
export const verifyOtp = async (req: Request, res: Response): Promise<void> => {
  try {
    const { email, otp } = req.body;

    if (!email || !otp) {
      res.status(400).json({ success: false, message: 'Email dan kode OTP wajib diisi' });
      return;
    }

    const cleanEmail = email.toString().trim().toLowerCase();
    const cleanOtp = otp.toString().trim();

    let entry = otpStore.get(cleanEmail);

    if (!entry) {
      // Fallback pengecekan ke tabel database user_otps untuk lingkungan Serverless
      const [dbOtps]: any = await db.query(
        `SELECT o.id, o.otp_code, o.expires_at 
         FROM user_otps o
         JOIN users u ON o.user_id = u.id
         WHERE LOWER(TRIM(u.email)) = ? AND o.otp_type = 'reset_password' AND o.otp_code = ? AND o.is_used = 0 AND o.expires_at > NOW()
         ORDER BY o.id DESC LIMIT 1`,
        [cleanEmail, cleanOtp]
      );

      if (dbOtps && dbOtps.length > 0) {
        entry = {
          code: cleanOtp,
          email: cleanEmail,
          verified: true,
          type: 'reset_password',
          expiresAt: Date.now() + 5 * 60 * 1000,
        };
        otpStore.set(cleanEmail, entry);
      }
    }

    if (!entry) {
      res.status(400).json({
        success: false,
        message: 'Kode OTP tidak ditemukan. Silakan minta kode OTP baru.',
      });
      return;
    }

    if (Date.now() > entry.expiresAt) {
      otpStore.delete(cleanEmail);
      res.status(400).json({
        success: false,
        message: 'Kode OTP telah kedaluwarsa. Silakan minta kode OTP baru.',
      });
      return;
    }

    if (entry.code !== cleanOtp) {
      res.status(400).json({
        success: false,
        message: 'Kode OTP salah. Periksa kembali kode yang Anda masukkan.',
      });
      return;
    }

    // Tandai OTP sebagai verified
    entry.verified = true;
    otpStore.set(cleanEmail, entry);

    res.status(200).json({
      success: true,
      message: 'Kode OTP berhasil diverifikasi!',
    });
    return;
  } catch (error: any) {
    console.error('Error verify OTP:', error);
    res.status(500).json({
      success: false,
      message: 'Terjadi kesalahan pada server',
    });
    return;
  }
};

// ============================================================
// RESET PASSWORD Ã¢â‚¬â€ Ubah kata sandi setelah OTP terverifikasi
// ============================================================
export const resetPassword = async (req: Request, res: Response): Promise<void> => {
  try {
    const { email, newPassword, otp } = req.body;

    if (!email || !newPassword || !otp) {
      res.status(400).json({ success: false, message: 'Email, kode OTP, dan kata sandi baru wajib diisi' });
      return;
    }

    if (newPassword.length < 8) {
      res.status(400).json({ success: false, message: 'Kata sandi minimal 8 karakter' });
      return;
    }

    // Cek kode OTP valid dari memori atau tabel user_otps
    const cleanEmail = email.toString().trim().toLowerCase();
    const cleanOtp = otp.toString().trim();

    let entry = otpStore.get(cleanEmail);
    let matchedDbOtpId: number | null = null;

    if (!entry || entry.code !== cleanOtp) {
      // Fallback pengecekan ke tabel database user_otps untuk lingkungan Serverless / post-restart
      const [dbOtps]: any = await db.query(
        `SELECT o.id, o.otp_code, o.expires_at 
         FROM user_otps o
         JOIN users u ON o.user_id = u.id
         WHERE LOWER(TRIM(u.email)) = ? AND o.otp_type = 'reset_password' AND o.otp_code = ? AND o.is_used = 0 AND o.expires_at > NOW()
         ORDER BY o.id DESC LIMIT 1`,
        [cleanEmail, cleanOtp]
      );

      if (dbOtps && dbOtps.length > 0) {
        matchedDbOtpId = Number(dbOtps[0].id);
        entry = {
          code: cleanOtp,
          email: cleanEmail,
          verified: true,
          type: 'reset_password',
          expiresAt: Date.now() + 5 * 60 * 1000,
        };
      }
    }

    if (!entry || entry.code !== cleanOtp) {
      res.status(400).json({
        success: false,
        message: 'OTP belum diverifikasi atau tidak valid. Silakan verifikasi OTP terlebih dahulu.',
      });
      return;
    }

    if (Date.now() > entry.expiresAt) {
      otpStore.delete(cleanEmail);
      res.status(400).json({
        success: false,
        message: 'Sesi reset telah kedaluwarsa. Silakan ulangi proses dari awal.',
      });
      return;
    }

    const [users]: any = await db.query('SELECT id FROM users WHERE LOWER(TRIM(email)) = ?', [cleanEmail]);
    if (!users || users.length === 0) {
      res.status(404).json({ success: false, message: 'Akun dengan email tersebut tidak ditemukan' });
      return;
    }

    const targetUserId = Number(users[0].id);
    const passwordHash = await bcrypt.hash(newPassword, 10);
    await db.query(
      'UPDATE users SET password_hash = ?, password_changed_at = NOW(), token_version = token_version + 1 WHERE id = ?',
      [passwordHash, targetUserId]
    );

    await db.query(
      "UPDATE user_otps SET is_used = 1 WHERE user_id = ? AND otp_type = 'reset_password' AND is_used = 0",
      [targetUserId]
    );
    if (matchedDbOtpId) {
      await db.query('UPDATE user_otps SET is_used = 1 WHERE id = ?', [matchedDbOtpId]);
    }

    // Hapus OTP dari store setelah berhasil reset
    otpStore.delete(cleanEmail);

    res.status(200).json({
      success: true,
      message: 'Kata sandi berhasil diperbarui',
    });
    return;
  } catch (error: any) {
    console.error('Error reset password:', error);
    res.status(500).json({
      success: false,
      message: 'Terjadi kesalahan pada server',
    });
    return;
  }
};



export const reuploadDocs = async (req: Request, res: Response): Promise<void> => {
  try {
    const userId = res.locals['userId'];
    if (!userId) {
      res.status(401).json({ success: false, message: 'Unauthorized' });
      return;
    }

    const files = req.files as { [fieldname: string]: Express.Multer.File[] } | undefined;
    const ktpFile = files?.ktp_file?.[0];
    const nibFile = files?.nib_file?.[0];
    const productImages = files?.product_images || files?.sample_product_images;

    if (!ktpFile && !nibFile && (!productImages || productImages.length === 0)) {
      res.status(400).json({ success: false, message: 'Harap unggah minimal satu dokumen untuk diperbaiki.' });
      return;
    }

    const updates: string[] = [];
    const params: any[] = [];

    if (ktpFile) {
      updates.push('ktp_file_url = ?');
      params.push(getUploadedFileUrl(ktpFile));
    }
    if (nibFile) {
      updates.push('nib_file_url = ?');
      params.push(getUploadedFileUrl(nibFile));
    }
    if (productImages && productImages.length > 0) {
      updates.push('sample_product_images = ?');
      params.push(
        JSON.stringify(
          productImages
            .map(f => getUploadedFileUrl(f))
            .filter((url): url is string => Boolean(url))
        )
      );
    }

    updates.push('is_verified = 0');
    updates.push('is_active = 1');
    updates.push('rejection_reason = NULL');
    updates.push('updated_at = NOW()');

    params.push(userId);

    await db.query(`UPDATE mitra_profiles SET ${updates.join(', ')} WHERE user_id = ?`, params);

    res.status(200).json({
      success: true,
      message: 'Dokumen berhasil diperbarui dan diajukan ulang untuk verifikasi admin!'
    });
  } catch (error) {
    console.error('Error reuploadDocs:', error);
    res.status(500).json({ success: false, message: 'Gagal memperbarui dokumen.' });
  }
};

// ============================================================
// VERIFIKASI OTP REGISTRASI MANUAL PENGUNJUNG
// ============================================================
export const verifyRegisterOtp = async (req: Request, res: Response): Promise<void> => {
  try {
    const { email, otp, name, password, phone } = req.body;

    if (!email || !otp) {
      res.status(400).json({ success: false, message: 'Email dan kode OTP wajib diisi' });
      return;
    }

    const cleanEmail = email.trim().toLowerCase();
    const entry = otpStore.get(cleanEmail);

    if (!entry || entry.type !== 'register') {
      res.status(400).json({
        success: false,
        message: 'Kode OTP pendaftaran tidak ditemukan atau sudah kadaluwarsa. Silakan minta kode baru.',
      });
      return;
    }

    if (Date.now() > entry.expiresAt) {
      otpStore.delete(cleanEmail);
      res.status(400).json({
        success: false,
        message: 'Kode OTP telah kedaluwarsa. Silakan minta kode OTP baru.',
      });
      return;
    }

    if (entry.code !== otp.trim()) {
      res.status(400).json({
        success: false,
        message: 'Kode OTP salah. Periksa kembali kode yang Anda terima.',
      });
      return;
    }

    const regData = entry.data || {};
    const regName = (name || regData.name || 'Pengguna').trim();
    const regPass = password || regData.password;
    const regPhone = phone || regData.phone;

    if (!regPass) {
      res.status(400).json({ success: false, message: 'Data pendaftaran tidak lengkap. Ulangi pendaftaran.' });
      return;
    }

    const [existing]: any = await db.query('SELECT id FROM users WHERE email = ?', [cleanEmail]);
    if (existing && existing.length > 0) {
      otpStore.delete(cleanEmail);
      res.status(409).json({ success: false, message: 'Email sudah terdaftar. Silakan langsung login.' });
      return;
    }

    const passwordHash = await bcrypt.hash(regPass, 10);
    const regUsername = (req.body.username || regData.username || '').trim().toLowerCase() || null;
    const cleanRegPhone = regPhone && String(regPhone).trim() ? String(regPhone).trim() : null;
    const rawBirth = req.body.birth_date ?? req.body.birthDate ?? regData.birth_date ?? null;
    const cleanBirthDate = rawBirth ? String(rawBirth).slice(0, 10) : null;

    const [result]: any = await db.query(
      'INSERT INTO users (name, username, phone, birth_date, email, password_hash, password_changed_at, role, is_active) VALUES (?, ?, ?, ?, ?, ?, NOW(), "pengunjung", 1)',
      [regName, regUsername, cleanRegPhone, cleanBirthDate, cleanEmail, passwordHash]
    );
    const newUserId = result.insertId;

    otpStore.delete(cleanEmail);

    const { token, refresh_token } = signTokenPair({ id: newUserId, email: cleanEmail, role: 'pengunjung' });

    res.status(201).json({
      success: true,
      message: 'Pendaftaran pengunjung berhasil terverifikasi!',
      data: {
        token,
        refresh_token,
        id: newUserId,
        name: regName,
        username: regUsername || cleanEmail.split('@')[0],
        phone: cleanRegPhone,
        birth_date: cleanBirthDate,
        email: cleanEmail,
        role: 'pengunjung',
        two_factor_enabled: false,
        has_password: true,
      },
      meta: { timestamp: new Date().toISOString() }
    });
    return;
  } catch (error) {
    console.error('Error verifyRegisterOtp:', error);
    res.status(500).json({ success: false, message: 'Terjadi kesalahan pada server saat verifikasi OTP.' });
  }
};

// ============================================================
// RESEND OTP REGISTRASI MANUAL PENGUNJUNG
// ============================================================
export const resendRegisterOtp = async (req: Request, res: Response): Promise<void> => {
  try {
    const { email, name } = req.body;

    if (!email) {
      res.status(400).json({ success: false, message: 'Email wajib diisi' });
      return;
    }

    const cleanEmail = email.trim().toLowerCase();
    const entry = otpStore.get(cleanEmail);

    const otp = Math.floor(100000 + Math.random() * 900000).toString();
    const expiresAt = Date.now() + 5 * 60 * 1000;

    otpStore.set(cleanEmail, {
      code: otp,
      email: cleanEmail,
      expiresAt,
      verified: false,
      type: 'register',
      data: entry?.data,
    });

    if (process.env['NODE_ENV'] !== 'production') {
      console.log('\n========================================');
      console.log(`[DEV RESEND REGISTER OTP] Kode OTP untuk ${cleanEmail}: ${otp}`);
      console.log('========================================\n');
    }

    try {
      await sendOTPEmail(cleanEmail, otp, name || entry?.data?.name || 'Pengguna');
      console.log(`✅ [OTP EMAIL] Email OTP resend berhasil terkirim ke ${cleanEmail}`);
    } catch (err: any) {
      console.error('⚠️ [OTP EMAIL] Gagal kirim ulang OTP email:', err.message);
    }

    res.status(200).json({
      success: true,
      message: 'Kode OTP baru telah dikirim ke email Anda.',
      data: {
        email: cleanEmail,
      },
      meta: { timestamp: new Date().toISOString() }
    });
  } catch (error) {
    console.error('Error resendRegisterOtp:', error);
    res.status(500).json({ success: false, message: 'Gagal mengirim ulang kode OTP.' });
  }
};

// ============================================================
// Cek Ketersediaan Username
// ============================================================
export const checkUsername = async (req: Request, res: Response): Promise<void> => {
  try {
    const rawUsername = (req.query['username'] || req.body['username'] || '').toString();
    const username = rawUsername.trim().toLowerCase();

    if (!username) {
      res.status(200).json({
        success: true,
        available: false,
        message: 'Username wajib diisi',
      });
      return;
    }

    if (username.length < 3) {
      res.status(200).json({
        success: true,
        available: false,
        message: 'Username minimal 3 karakter',
      });
      return;
    }

    if (username.length > 30) {
      res.status(200).json({
        success: true,
        available: false,
        message: 'Username maksimal 30 karakter',
      });
      return;
    }

    const regex = /^[a-zA-Z0-9_]+$/;
    if (!regex.test(username)) {
      res.status(200).json({
        success: true,
        available: false,
        message: 'Username hanya boleh huruf, angka, dan underscore (_)',
      });
      return;
    }

    const [rows]: any = await db.query('SELECT id FROM users WHERE username = ? LIMIT 1', [username]);
    const isAvailable = !rows || rows.length === 0;

    res.status(200).json({
      success: true,
      available: isAvailable,
      username,
      message: isAvailable ? 'Username tersedia' : 'Username sudah digunakan',
      meta: { timestamp: new Date().toISOString() },
    });
  } catch (error) {
    console.error('Error checkUsername:', error);
    res.status(500).json({
      success: false,
      available: false,
      message: 'Gagal memeriksa ketersediaan username.',
    });
  }
};

// ============================================================
// REFRESH TOKEN — Perpanjang sesi dengan refresh token
// Body: { refresh_token: string }
// ============================================================
export const refreshToken = async (req: Request, res: Response): Promise<void> => {
  try {
    const { refresh_token } = req.body;

    if (!refresh_token || typeof refresh_token !== 'string') {
      res.status(400).json({ success: false, message: 'Refresh token wajib dikirim' });
      return;
    }

    const refreshSecret = process.env['JWT_REFRESH_SECRET'] || process.env['JWT_SECRET'];
    if (!refreshSecret) {
      res.status(500).json({ success: false, message: 'Konfigurasi server tidak lengkap' });
      return;
    }

    let decoded: any;
    try {
      decoded = jwt.verify(refresh_token, refreshSecret);
    } catch (err) {
      res.status(401).json({ success: false, message: 'Refresh token tidak valid atau kedaluwarsa. Silakan login ulang.' });
      return;
    }

    if (decoded.type !== 'refresh') {
      res.status(401).json({ success: false, message: 'Token bukan refresh token. Silakan login ulang.' });
      return;
    }

    // Pastikan user masih aktif & versi token masih berlaku (tidak di-kick)
    const [users]: any = await db.query('SELECT id, email, role, is_active, token_version FROM users WHERE id = ? LIMIT 1', [decoded.userId]);
    if (!users || users.length === 0) {
      res.status(401).json({ success: false, message: 'Pengguna tidak ditemukan. Silakan login ulang.' });
      return;
    }
    const user = users[0];
    if (user.is_active === 0) {
      res.status(403).json({ success: false, message: 'Akun Anda sedang dinonaktifkan.' });
      return;
    }
    if ((decoded.ver ?? 0) !== user.token_version) {
      res.status(401).json({ success: false, message: 'Sesi Anda telah diakhiri dari perangkat lain. Silakan login ulang.' });
      return;
    }

    const { token, refresh_token: newRefreshToken } = signTokenPair({ id: user.id, email: user.email, role: user.role, ver: user.token_version });

    res.status(200).json({
      success: true,
      message: 'Token berhasil diperbarui.',
      data: {
        token,
        refresh_token: newRefreshToken,
        id: user.id,
        email: user.email,
        role: user.role,
      },
      meta: { timestamp: new Date().toISOString() }
    });
    return;
  } catch (error) {
    console.error('Error refresh token:', error);
    res.status(500).json({ success: false, message: 'Terjadi kesalahan pada server' });
    return;
  }
};

// ============================================================
// VERIFIKASI OTP LOGIN (2FA) & KIRIM ULANG OTP LOGIN
// ============================================================
export const verifyLoginOtp = async (req: Request, res: Response): Promise<void> => {
  try {
    const { email, otp } = req.body;
    if (!email || !otp) {
      res.status(400).json({ success: false, message: 'Email dan kode OTP wajib diisi.' });
      return;
    }

    const cleanEmail = String(email).trim().toLowerCase();
    const cleanOtp = String(otp).trim();

    const [users]: any = await db.query(
      `SELECT u.id, u.name, COALESCE(NULLIF(TRIM(u.username), ''), SUBSTRING_INDEX(u.email, '@', 1)) AS username,
              u.phone, u.birth_date, u.gender, u.email, u.role, u.is_active, u.avatar_url,
              u.token_version, u.two_factor_enabled, u.password_changed_at,
              (u.password_hash IS NOT NULL AND u.password_hash != '') AS has_password,
              m.store_name, m.is_verified, m.rejection_reason
       FROM users u
       LEFT JOIN mitra_profiles m ON u.id = m.user_id
       WHERE u.email = ? LIMIT 1`,
      [cleanEmail]
    );

    if (!users || users.length === 0) {
      res.status(404).json({ success: false, message: 'Akun tidak ditemukan.' });
      return;
    }

    const user = users[0];
    if (user.is_active === 0) {
      res.status(403).json({ success: false, message: 'Akun Anda sedang dinonaktifkan.' });
      return;
    }

    const [otpRows]: any = await db.query(
      `SELECT id, otp_code, expires_at
       FROM user_otps
       WHERE user_id = ? AND otp_type = 'login' AND is_used = 0
       ORDER BY id DESC LIMIT 1`,
      [user.id]
    );

    if (!otpRows || otpRows.length === 0) {
      res.status(400).json({
        success: false,
        message: 'Kode OTP login tidak ditemukan atau sudah digunakan. Silakan minta kode baru.',
      });
      return;
    }

    const otpRow = otpRows[0];
    if (new Date(otpRow.expires_at).getTime() < Date.now()) {
      await db.query('UPDATE user_otps SET is_used = 1 WHERE id = ?', [otpRow.id]);
      res.status(400).json({
        success: false,
        message: 'Kode OTP telah kedaluwarsa. Silakan kirim ulang kode OTP.',
      });
      return;
    }

    if (String(otpRow.otp_code).trim() !== cleanOtp) {
      res.status(400).json({
        success: false,
        message: 'Kode OTP salah. Silakan periksa kembali email Anda.',
      });
      return;
    }

    await db.query('UPDATE user_otps SET is_used = 1 WHERE id = ?', [otpRow.id]);

    const { token, refresh_token } = signTokenPair({
      id: user.id,
      email: user.email,
      role: user.role,
      ver: user.token_version,
    });

    res.locals['userId'] = user.id;
    res.locals['role'] = user.role;
    if (user.role === 'mitra' && Number(user.is_verified) !== 1) {
      applyMitraPendingAuthLog(res, {
        userId: user.id,
        email: user.email,
        storeName: user.store_name,
        ownerName: user.name,
        isVerified: user.is_verified,
        rejectionReason: user.rejection_reason,
        authMethod: 'otp_2fa',
      });
    } else {
      res.locals['logCategory'] = 'auth';
      res.locals['logEventName'] = 'auth.login.succeeded';
      res.locals['logSeverity'] = 'success';
      res.locals['logOutcome'] = 'success';
      res.locals['logMessage'] = `Verifikasi OTP 2FA & login berhasil untuk akun ${user.role} (${user.email})`;
    }

    res.cookie('token', token, {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'lax',
      maxAge: 24 * 60 * 60 * 1000,
    });

    res.status(200).json({
      success: true,
      message: 'Verifikasi OTP berhasil! Selamat datang kembali.',
      data: {
        token,
        refresh_token,
        id: user.id,
        name: user.name,
        username: user.username,
        phone: user.phone,
        birth_date: user.birth_date,
        gender: user.gender,
        email: user.email,
        role: user.role,
        avatar_url: user.avatar_url,
        two_factor_enabled: Boolean(user.two_factor_enabled),
        password_changed_at: user.password_changed_at,
        has_password: Boolean(user.has_password),
        store_name: user.store_name,
        is_verified: user.is_verified,
        rejection_reason: user.rejection_reason,
      },
      meta: { timestamp: new Date().toISOString() },
    });
  } catch (error) {
    console.error('Error verifyLoginOtp:', error);
    res.status(500).json({ success: false, message: 'Gagal memverifikasi kode OTP login.' });
  }
};

export const resendLoginOtp = async (req: Request, res: Response): Promise<void> => {
  try {
    const { email } = req.body;
    if (!email) {
      res.status(400).json({ success: false, message: 'Email wajib diisi.' });
      return;
    }

    const cleanEmail = String(email).trim().toLowerCase();
    const [users]: any = await db.query(
      'SELECT id, name, email, is_active FROM users WHERE email = ? LIMIT 1',
      [cleanEmail]
    );

    if (!users || users.length === 0) {
      res.status(404).json({ success: false, message: 'Akun tidak ditemukan.' });
      return;
    }

    const user = users[0];
    if (user.is_active === 0) {
      res.status(403).json({ success: false, message: 'Akun sedang dinonaktifkan.' });
      return;
    }

    const loginOtp = Math.floor(100000 + Math.random() * 900000).toString();
    await db.query(
      "UPDATE user_otps SET is_used = 1 WHERE user_id = ? AND otp_type = 'login' AND is_used = 0",
      [user.id]
    );
    await db.query(
      "INSERT INTO user_otps (user_id, otp_code, otp_type, expires_at, is_used) VALUES (?, ?, 'login', DATE_ADD(NOW(), INTERVAL 5 MINUTE), 0)",
      [user.id, loginOtp]
    );

    await sendOTPEmail(user.email, loginOtp, user.name, 'login');

    res.status(200).json({
      success: true,
      message: 'Kode OTP baru telah dikirim ke email Anda.',
      data: { email: user.email },
    });
  } catch (error) {
    console.error('Error resendLoginOtp:', error);
    res.status(500).json({ success: false, message: 'Gagal mengirim ulang kode OTP login.' });
  }
};

// ============================================================
// AUTENTIKASI 2 LANGKAH (2FA) — AKTIVASI & PENONAKTIFAN VIA EMAIL ASLI
// ============================================================
export const requestTwoFactorOtp = async (req: Request, res: Response): Promise<void> => {
  try {
    const userId = res.locals['userId'];
    const { action } = req.body; // 'enable' | 'disable'
    if (!userId) {
      res.status(401).json({ success: false, message: 'Unauthorized' });
      return;
    }

    const [users]: any = await db.query(
      'SELECT id, name, email, two_factor_enabled FROM users WHERE id = ? LIMIT 1',
      [userId]
    );
    if (!users || users.length === 0) {
      res.status(404).json({ success: false, message: 'Pengguna tidak ditemukan.' });
      return;
    }

    const user = users[0];
    const otpType = action === 'disable' ? '2fa_disable' : '2fa_enable';
    const otpCode = Math.floor(100000 + Math.random() * 900000).toString();

    await db.query(
      'UPDATE user_otps SET is_used = 1 WHERE user_id = ? AND otp_type = ? AND is_used = 0',
      [user.id, otpType]
    );
    await db.query(
      'INSERT INTO user_otps (user_id, otp_code, otp_type, expires_at, is_used) VALUES (?, ?, ?, DATE_ADD(NOW(), INTERVAL 5 MINUTE), 0)',
      [user.id, otpCode, otpType]
    );

    await sendOTPEmail(user.email, otpCode, user.name, otpType);

    res.status(200).json({
      success: true,
      message: `Kode OTP konfirmasi telah dikirim ke ${user.email}.`,
      data: { email: user.email, action },
    });
  } catch (error) {
    console.error('Error requestTwoFactorOtp:', error);
    res.status(500).json({
      success: false,
      message: 'Gagal mengirim email kode OTP 2FA. Periksa koneksi server email.',
    });
  }
};

export const verifyTwoFactorOtp = async (req: Request, res: Response): Promise<void> => {
  try {
    const userId = res.locals['userId'];
    const { action, otp } = req.body;
    if (!userId) {
      res.status(401).json({ success: false, message: 'Unauthorized' });
      return;
    }

    const otpType = action === 'disable' ? '2fa_disable' : '2fa_enable';
    const [otpRows]: any = await db.query(
      `SELECT id, otp_code, expires_at
       FROM user_otps
       WHERE user_id = ? AND otp_type = ? AND is_used = 0
       ORDER BY id DESC LIMIT 1`,
      [userId, otpType]
    );

    if (!otpRows || otpRows.length === 0) {
      res.status(400).json({
        success: false,
        message: 'Kode OTP tidak ditemukan atau sudah digunakan. Silakan kirim ulang kode.',
      });
      return;
    }

    const otpRow = otpRows[0];
    if (new Date(otpRow.expires_at).getTime() < Date.now()) {
      await db.query('UPDATE user_otps SET is_used = 1 WHERE id = ?', [otpRow.id]);
      res.status(400).json({
        success: false,
        message: 'Kode OTP telah kedaluwarsa. Silakan kirim ulang kode OTP.',
      });
      return;
    }

    if (String(otpRow.otp_code).trim() !== String(otp).trim()) {
      res.status(400).json({
        success: false,
        message: 'Kode OTP salah. Silakan periksa kembali kotak masuk email Anda.',
      });
      return;
    }

    const enabledVal = action === 'disable' ? 0 : 1;
    await db.query('UPDATE user_otps SET is_used = 1 WHERE id = ?', [otpRow.id]);
    await db.query('UPDATE users SET two_factor_enabled = ? WHERE id = ?', [enabledVal, userId]);

    res.status(200).json({
      success: true,
      message:
        enabledVal === 1
          ? 'Autentikasi 2 Langkah (2FA) berhasil diaktifkan.'
          : 'Autentikasi 2 Langkah (2FA) berhasil dinonaktifkan.',
      data: { two_factor_enabled: Boolean(enabledVal) },
    });
  } catch (error) {
    console.error('Error verifyTwoFactorOtp:', error);
    res.status(500).json({ success: false, message: 'Gagal memverifikasi OTP 2FA.' });
  }
};

// ============================================================
// UBAH KATA SANDI PENGGUNA AKTIF & LOGOUT PERANGKAT LAIN
// ============================================================
export const changePassword = async (req: Request, res: Response): Promise<void> => {
  try {
    const userId = res.locals['userId'];
    const { currentPassword, newPassword } = req.body;
    if (!userId) {
      res.status(401).json({ success: false, message: 'Unauthorized' });
      return;
    }

    if (!newPassword || String(newPassword).length < 8) {
      res.status(400).json({
        success: false,
        message: 'Kata sandi baru minimal harus 8 karakter.',
      });
      return;
    }

    const [users]: any = await db.query(
      'SELECT id, password_hash FROM users WHERE id = ? LIMIT 1',
      [userId]
    );
    if (!users || users.length === 0) {
      res.status(404).json({ success: false, message: 'Pengguna tidak ditemukan.' });
      return;
    }

    const user = users[0];
    if (user.password_hash) {
      if (!currentPassword || !String(currentPassword).trim()) {
        res.status(400).json({
          success: false,
          message: 'Kata sandi saat ini wajib diisi untuk verifikasi keamanan.',
        });
        return;
      }
      const matches = await bcrypt.compare(String(currentPassword), user.password_hash);
      if (!matches) {
        res.status(400).json({
          success: false,
          message: 'Kata sandi saat ini tidak sesuai.',
        });
        return;
      }
    }

    const newHash = await bcrypt.hash(String(newPassword), 10);
    await db.query(
      'UPDATE users SET password_hash = ?, password_changed_at = NOW() WHERE id = ?',
      [newHash, userId]
    );

    res.status(200).json({
      success: true,
      message: 'Kata sandi berhasil diperbarui!',
      data: {
        password_changed_at: new Date().toISOString(),
        has_password: true,
      },
    });
  } catch (error) {
    console.error('Error changePassword:', error);
    res.status(500).json({ success: false, message: 'Gagal memperbarui kata sandi.' });
  }
};

export const logoutOtherDevices = async (_req: Request, res: Response): Promise<void> => {
  try {
    const userId = res.locals['userId'];
    if (!userId) {
      res.status(401).json({ success: false, message: 'Unauthorized' });
      return;
    }

    await db.query('UPDATE users SET token_version = token_version + 1 WHERE id = ?', [userId]);
    const [users]: any = await db.query(
      'SELECT id, email, role, token_version FROM users WHERE id = ? LIMIT 1',
      [userId]
    );
    if (!users || users.length === 0) {
      res.status(404).json({ success: false, message: 'Pengguna tidak ditemukan.' });
      return;
    }

    const user = users[0];
    const { token, refresh_token } = signTokenPair({
      id: user.id,
      email: user.email,
      role: user.role,
      ver: user.token_version,
    });

    res.status(200).json({
      success: true,
      message: 'Seluruh sesi perangkat lain berhasil dikeluarkan.',
      data: { token, refresh_token },
    });
  } catch (error) {
    console.error('Error logoutOtherDevices:', error);
    res.status(500).json({ success: false, message: 'Gagal mengeluarkan sesi perangkat lain.' });
  }
};
