import { DataTypes, Model } from 'sequelize';
import sequelize from '../config/database.js';

class AiSetting extends Model {
  declare id: number;
  declare is_auto_reply_active: boolean;
  declare provider: string | null;
  declare model_name: string;
  declare api_key: string | null;
  declare system_prompt: string | null;
}

AiSetting.init({
  id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
  is_auto_reply_active: { type: DataTypes.BOOLEAN, defaultValue: true },
  provider: { type: DataTypes.STRING(50), allowNull: true },
  model_name: { type: DataTypes.STRING(255), defaultValue: 'gemini-3.5-flash-lite' },
  api_key: { type: DataTypes.TEXT, allowNull: true },
  system_prompt: { type: DataTypes.TEXT, allowNull: true }
}, {
  sequelize,
  tableName: 'ai_settings',
  timestamps: false
});

export default AiSetting;

