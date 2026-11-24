import { Model } from 'sequelize';
declare class AiSetting extends Model {
    id: number;
    is_auto_reply_active: boolean;
    provider: string | null;
    model_name: string;
    api_key: string | null;
    system_prompt: string | null;
}
export default AiSetting;
//# sourceMappingURL=AiSetting.d.ts.map