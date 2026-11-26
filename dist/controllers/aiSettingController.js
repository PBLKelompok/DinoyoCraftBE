"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.updateAiSettings = exports.verifyAiApiKey = exports.getAiSettings = void 0;
const AiSetting_js_1 = __importDefault(require("../models/AiSetting.js"));
const database_js_1 = __importDefault(require("../config/database.js"));
const aiController_js_1 = require("./aiController.js");
const aiProviderService_js_1 = require("../services/aiProviderService.js");
async function getCatalogStats() {
    try {
        const [prodRows] = await database_js_1.default.query('SELECT COUNT(*) AS total FROM products WHERE is_deleted = 0');
        const [storeRows] = await database_js_1.default.query('SELECT COUNT(*) AS total FROM mitra_profiles WHERE is_active = 1');
        return {
            catalogCount: Number(prodRows?.[0]?.total ?? 0),
            storeCount: Number(storeRows?.[0]?.total ?? 0),
        };
    }
    catch {
        return { catalogCount: 0, storeCount: 0 };
    }
}
function resolveProvider(explicitProvider, plainKey, modelName) {
    const normalized = String(explicitProvider || '').trim().toLowerCase();
    if (normalized && normalized in aiProviderService_js_1.PROVIDER_LABELS) {
        return normalized;
    }
    return (0, aiProviderService_js_1.detectProviderByPrefix)(plainKey) || (0, aiProviderService_js_1.inferProviderFromModel)(modelName) || null;
}
const getAiSettings = async (_req, res) => {
    try {
        const [setting] = await AiSetting_js_1.default.findOrCreate({
            where: { id: 1 },
            defaults: {
                is_auto_reply_active: true,
                provider: null,
                model_name: 'gemini-3.5-flash-lite',
                api_key: '',
                system_prompt: aiProviderService_js_1.DEFAULT_DINOYOCRAFT_SYSTEM_PROMPT,
            },
        });
        const currentPrompt = String(setting.system_prompt || '').trim();
        let effectivePrompt = currentPrompt;
        if (!currentPrompt || aiProviderService_js_1.LEGACY_SYSTEM_PROMPTS.has(currentPrompt)) {
            effectivePrompt = aiProviderService_js_1.DEFAULT_DINOYOCRAFT_SYSTEM_PROMPT;
            await AiSetting_js_1.default.update({ system_prompt: aiProviderService_js_1.DEFAULT_DINOYOCRAFT_SYSTEM_PROMPT }, { where: { id: setting.id } }).catch(() => { });
        }
        const plainKey = (0, aiProviderService_js_1.decryptApiKey)(setting.api_key);
        const detectedProvider = resolveProvider(setting.provider, plainKey, setting.model_name);
        const { catalogCount, storeCount } = await getCatalogStats();
        res.json({
            success: true,
            data: {
                id: setting.id,
                is_auto_reply_active: Boolean(setting.is_auto_reply_active),
                provider: detectedProvider,
                provider_label: detectedProvider ? aiProviderService_js_1.PROVIDER_LABELS[detectedProvider] : 'Belum Diatur',
                model_name: setting.model_name || 'gemini-3.5-flash-lite',
                has_api_key: Boolean(plainKey),
                masked_api_key: plainKey ? (0, aiProviderService_js_1.maskApiKey)(plainKey) : '',
                system_prompt: effectivePrompt,
                default_system_prompt: aiProviderService_js_1.DEFAULT_DINOYOCRAFT_SYSTEM_PROMPT,
                catalog_count: catalogCount,
                store_count: storeCount,
            },
        });
    }
    catch (error) {
        console.error('❌ [getAiSettings] Error:', error);
        res.status(500).json({ success: false, message: 'Gagal memuat pengaturan AI.' });
    }
};
exports.getAiSettings = getAiSettings;
const verifyAiApiKey = async (req, res) => {
    try {
        const rawInput = typeof req.body?.api_key === 'string' ? req.body.api_key.trim() : '';
        const providerHintRaw = typeof req.body?.provider === 'string' ? req.body.provider.trim().toLowerCase() : '';
        const providerHint = providerHintRaw && providerHintRaw in aiProviderService_js_1.PROVIDER_LABELS
            ? providerHintRaw
            : null;
        let keyToVerify = '';
        let testingSavedKey = false;
        if (rawInput && !(0, aiProviderService_js_1.isMaskedPlaceholder)(rawInput)) {
            keyToVerify = rawInput;
        }
        else {
            const setting = await AiSetting_js_1.default.findByPk(1);
            keyToVerify = (0, aiProviderService_js_1.decryptApiKey)(setting?.api_key);
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
        const verification = await (0, aiProviderService_js_1.verifyAndDiscoverModels)(keyToVerify, providerHint);
        if (verification.valid && testingSavedKey && verification.provider) {
            await AiSetting_js_1.default.update({ provider: verification.provider }, { where: { id: 1 } }).catch(() => { });
        }
        res.json({
            success: true,
            data: verification,
        });
    }
    catch (error) {
        console.error('❌ [verifyAiApiKey] Error:', error);
        res.status(500).json({
            success: false,
            message: 'Gagal memeriksa koneksi API AI.',
        });
    }
};
exports.verifyAiApiKey = verifyAiApiKey;
const updateAiSettings = async (req, res) => {
    try {
        const { is_auto_reply_active, provider, model_name, api_key, system_prompt, clear_api_key, } = req.body || {};
        const [existing] = await AiSetting_js_1.default.findOrCreate({
            where: { id: 1 },
            defaults: {
                is_auto_reply_active: true,
                provider: null,
                model_name: 'gemini-3.5-flash-lite',
                api_key: '',
                system_prompt: aiProviderService_js_1.DEFAULT_DINOYOCRAFT_SYSTEM_PROMPT,
            },
        });
        const existingPlainKey = (0, aiProviderService_js_1.decryptApiKey)(existing.api_key);
        let nextPlainKey = existingPlainKey;
        let nextEncryptedKey = existing.api_key || '';
        if (clear_api_key === true) {
            nextPlainKey = '';
            nextEncryptedKey = '';
        }
        else if (typeof api_key === 'string' && api_key.trim() && !(0, aiProviderService_js_1.isMaskedPlaceholder)(api_key)) {
            nextPlainKey = api_key.trim();
            nextEncryptedKey = (0, aiProviderService_js_1.encryptApiKey)(nextPlainKey);
        }
        else if (existingPlainKey && existing.api_key && !(0, aiProviderService_js_1.isEncryptedApiKey)(existing.api_key)) {
            // Tingkatkan keamanan key lama yang tersimpan plaintext agar terenkripsi di database
            nextEncryptedKey = (0, aiProviderService_js_1.encryptApiKey)(existingPlainKey);
        }
        const nextModel = typeof model_name === 'string' && model_name.trim()
            ? model_name.trim()
            : existing.model_name || 'gemini-3.5-flash-lite';
        const nextActive = typeof is_auto_reply_active === 'boolean'
            ? is_auto_reply_active
            : is_auto_reply_active !== undefined
                ? Boolean(Number(is_auto_reply_active))
                : Boolean(existing.is_auto_reply_active);
        const nextPrompt = typeof system_prompt === 'string' && system_prompt.trim()
            ? system_prompt.trim()
            : existing.system_prompt || aiProviderService_js_1.DEFAULT_DINOYOCRAFT_SYSTEM_PROMPT;
        const nextProvider = clear_api_key === true
            ? null
            : resolveProvider(provider ?? (nextPlainKey !== existingPlainKey ? (0, aiProviderService_js_1.detectProviderByPrefix)(nextPlainKey) : existing.provider), nextPlainKey, nextModel);
        await AiSetting_js_1.default.update({
            is_auto_reply_active: nextActive,
            provider: nextProvider,
            model_name: nextModel,
            api_key: nextEncryptedKey,
            system_prompt: nextPrompt,
        }, { where: { id: existing.id } });
        (0, aiController_js_1.clearDailyInsightCache)();
        const { catalogCount, storeCount } = await getCatalogStats();
        res.json({
            success: true,
            message: 'Pengaturan AI berhasil disimpan & API Key terenkripsi aman.',
            data: {
                id: existing.id,
                is_auto_reply_active: nextActive,
                provider: nextProvider,
                provider_label: nextProvider ? aiProviderService_js_1.PROVIDER_LABELS[nextProvider] : 'Belum Diatur',
                model_name: nextModel,
                has_api_key: Boolean(nextPlainKey),
                masked_api_key: nextPlainKey ? (0, aiProviderService_js_1.maskApiKey)(nextPlainKey) : '',
                system_prompt: nextPrompt,
                default_system_prompt: aiProviderService_js_1.DEFAULT_DINOYOCRAFT_SYSTEM_PROMPT,
                catalog_count: catalogCount,
                store_count: storeCount,
            },
        });
    }
    catch (error) {
        console.error('❌ [updateAiSettings] Error:', error);
        res.status(500).json({ success: false, message: 'Gagal menyimpan pengaturan AI.' });
    }
};
exports.updateAiSettings = updateAiSettings;
//# sourceMappingURL=aiSettingController.js.map