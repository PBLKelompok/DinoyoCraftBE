import { Request, Response } from 'express';
import AiSetting from '../models/AiSetting.js';
import pool from '../config/database.js';
import {
  DEFAULT_DINOYOCRAFT_SYSTEM_PROMPT,
  LEGACY_SYSTEM_PROMPTS,
  PROVIDER_LABELS,
  ProviderId,
  decryptApiKey,
  detectProviderByPrefix,
  encryptApiKey,
  inferProviderFromModel,
  isEncryptedApiKey,
  isMaskedPlaceholder,
  maskApiKey,
  verifyAndDiscoverModels,
} from '../services/aiProviderService.js';

async function getCatalogStats(): Promise<{ catalogCount: number; storeCount: number }> {
  try {
    const [prodRows]: any = await pool.query(
      'SELECT COUNT(*) AS total FROM products WHERE is_deleted = 0'
    );
    const [storeRows]: any = await pool.query(
      'SELECT COUNT(*) AS total FROM mitra_profiles WHERE is_active = 1'
    );
    return {
      catalogCount: Number(prodRows?.[0]?.total ?? 0),
      storeCount: Number(storeRows?.[0]?.total ?? 0),
    };
  } catch {
    return { catalogCount: 0, storeCount: 0 };
  }
}

function resolveProvider(
  explicitProvider: string | null | undefined,
  plainKey: string,
  modelName: string
): ProviderId | null {
  const normalized = String(explicitProvider || '').trim().toLowerCase() as ProviderId;
  if (normalized && normalized in PROVIDER_LABELS) {
    return normalized;
  }
  return detectProviderByPrefix(plainKey) || inferProviderFromModel(modelName) || null;
}

export const getAiSettings = async (_req: Request, res: Response) => {
  try {
    const [setting] = await AiSetting.findOrCreate({
      where: { id: 1 },
      defaults: {
        is_auto_reply_active: true,
        provider: null,
        model_name: 'gemini-3.5-flash-lite',
        api_key: '',
        system_prompt: DEFAULT_DINOYOCRAFT_SYSTEM_PROMPT,
      },
    });

    const currentPrompt = String(setting.system_prompt || '').trim();
    let effectivePrompt = currentPrompt;
    if (!currentPrompt || LEGACY_SYSTEM_PROMPTS.has(currentPrompt)) {
      effectivePrompt = DEFAULT_DINOYOCRAFT_SYSTEM_PROMPT;
      await AiSetting.update(
        { system_prompt: DEFAULT_DINOYOCRAFT_SYSTEM_PROMPT },
        { where: { id: setting.id } }
      ).catch(() => { });
    }

    const plainKey = decryptApiKey(setting.api_key);
    const detectedProvider = resolveProvider(setting.provider, plainKey, setting.model_name);
    const { catalogCount, storeCount } = await getCatalogStats();

    res.json({
      success: true,
      data: {
        id: setting.id,
        is_auto_reply_active: Boolean(setting.is_auto_reply_active),
        provider: detectedProvider,
        provider_label: detectedProvider ? PROVIDER_LABELS[detectedProvider] : 'Belum Diatur',
        model_name: setting.model_name || 'gemini-3.5-flash-lite',
        has_api_key: Boolean(plainKey),
        masked_api_key: plainKey ? maskApiKey(plainKey) : '',
        system_prompt: effectivePrompt,
        default_system_prompt: DEFAULT_DINOYOCRAFT_SYSTEM_PROMPT,
        catalog_count: catalogCount,
        store_count: storeCount,
      },
    });
  } catch (error) {
    console.error('❌ [getAiSettings] Error:', error);
    res.status(500).json({ success: false, message: 'Gagal memuat pengaturan AI.' });
  }
};

export const verifyAiApiKey = async (req: Request, res: Response) => {
  try {
    const rawInput = typeof req.body?.api_key === 'string' ? req.body.api_key.trim() : '';
    const providerHintRaw =
      typeof req.body?.provider === 'string' ? req.body.provider.trim().toLowerCase() : '';
    const providerHint =
      providerHintRaw && providerHintRaw in PROVIDER_LABELS
        ? (providerHintRaw as ProviderId)
        : null;

    let keyToVerify = '';
    let testingSavedKey = false;

    if (rawInput && !isMaskedPlaceholder(rawInput)) {
      keyToVerify = rawInput;
    } else {
      const setting = await AiSetting.findByPk(1);
      keyToVerify = decryptApiKey(setting?.api_key);
      testingSavedKey = true;
    }

    if (!keyToVerify) {
      res.json({
        success: true,
        data: {
          valid: false,
          provider: null,
          providerLabel: 'Belum Diatur',
          latencyMs: 0,
          models: [],
          recommendedModel: null,
          message: 'API Key belum diisi. Silakan tempel API Key terlebih dahulu.',
        },
      });
      return;
    }

    const verification = await verifyAndDiscoverModels(keyToVerify, providerHint);

    if (verification.valid && testingSavedKey && verification.provider) {
      await AiSetting.update(
        { provider: verification.provider },
        { where: { id: 1 } }
      ).catch(() => { });
    }

    res.json({
      success: true,
      data: verification,
    });
  } catch (error) {
    console.error('❌ [verifyAiApiKey] Error:', error);
    res.status(500).json({
      success: false,
      message: 'Gagal memeriksa koneksi API AI.',
    });
  }
};

export const updateAiSettings = async (req: Request, res: Response) => {
  try {
    const {
      is_auto_reply_active,
      provider,
      model_name,
      api_key,
      system_prompt,
      clear_api_key,
    } = req.body || {};

    const [existing] = await AiSetting.findOrCreate({
      where: { id: 1 },
      defaults: {
        is_auto_reply_active: true,
        provider: null,
        model_name: 'gemini-3.5-flash-lite',
        api_key: '',
        system_prompt: DEFAULT_DINOYOCRAFT_SYSTEM_PROMPT,
      },
    });

    const existingPlainKey = decryptApiKey(existing.api_key);
    let nextPlainKey = existingPlainKey;
    let nextEncryptedKey = existing.api_key || '';

    if (clear_api_key === true) {
      nextPlainKey = '';
      nextEncryptedKey = '';
    } else if (typeof api_key === 'string' && api_key.trim() && !isMaskedPlaceholder(api_key)) {
      nextPlainKey = api_key.trim();
      nextEncryptedKey = encryptApiKey(nextPlainKey);
    } else if (existingPlainKey && existing.api_key && !isEncryptedApiKey(existing.api_key)) {
      // Tingkatkan keamanan key lama yang tersimpan plaintext agar terenkripsi di database
      nextEncryptedKey = encryptApiKey(existingPlainKey);
    }

    const nextModel =
      typeof model_name === 'string' && model_name.trim()
        ? model_name.trim()
        : existing.model_name || 'gemini-3.5-flash-lite';

    const nextActive =
      typeof is_auto_reply_active === 'boolean'
        ? is_auto_reply_active
        : is_auto_reply_active !== undefined
          ? Boolean(Number(is_auto_reply_active))
          : Boolean(existing.is_auto_reply_active);

    const nextPrompt =
      typeof system_prompt === 'string' && system_prompt.trim()
        ? system_prompt.trim()
        : existing.system_prompt || DEFAULT_DINOYOCRAFT_SYSTEM_PROMPT;

    const nextProvider = clear_api_key === true
      ? null
      : resolveProvider(
        provider ?? (nextPlainKey !== existingPlainKey ? detectProviderByPrefix(nextPlainKey) : existing.provider),
        nextPlainKey,
        nextModel
      );

    await AiSetting.update(
      {
        is_auto_reply_active: nextActive,
        provider: nextProvider,
        model_name: nextModel,
        api_key: nextEncryptedKey,
        system_prompt: nextPrompt,
      },
      { where: { id: existing.id } }
    );

    const { catalogCount, storeCount } = await getCatalogStats();

    res.json({
      success: true,
      message: 'Pengaturan AI berhasil disimpan & API Key terenkripsi aman.',
      data: {
        id: existing.id,
        is_auto_reply_active: nextActive,
        provider: nextProvider,
        provider_label: nextProvider ? PROVIDER_LABELS[nextProvider] : 'Belum Diatur',
        model_name: nextModel,
        has_api_key: Boolean(nextPlainKey),
        masked_api_key: nextPlainKey ? maskApiKey(nextPlainKey) : '',
        system_prompt: nextPrompt,
        default_system_prompt: DEFAULT_DINOYOCRAFT_SYSTEM_PROMPT,
        catalog_count: catalogCount,
        store_count: storeCount,
      },
    });
  } catch (error) {
    console.error('❌ [updateAiSettings] Error:', error);
    res.status(500).json({ success: false, message: 'Gagal menyimpan pengaturan AI.' });
  }
};
