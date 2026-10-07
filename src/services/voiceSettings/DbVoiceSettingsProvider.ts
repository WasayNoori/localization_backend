// src/services/voiceSettings/DbVoiceSettingsProvider.ts
import { eq } from "drizzle-orm";
import type { Database } from "../../db/client.js";
import { languageVoiceSettings } from "../../db/schema.js";
import {
  VoiceNotConfiguredError,
  type IVoiceSettingsProvider,
  type LanguageVoiceConfig,
} from "../../interfaces/IvoiceSettingsProvider.js";

/** Reads language_voice_settings (edited in Settings / PUT /languages/:lang/voice-settings). */
export class DbVoiceSettingsProvider implements IVoiceSettingsProvider {
  constructor(private readonly db: Database) {}

  async getSettings(language: string): Promise<LanguageVoiceConfig> {
    const [row] = await this.db.select().from(languageVoiceSettings).where(eq(languageVoiceSettings.targetLanguage, language)).limit(1);
    if (!row) throw new VoiceNotConfiguredError(language);
    return { language, voiceId: row.voiceId, modelId: row.modelId, voiceSettings: row.voiceSettings };
  }
}
