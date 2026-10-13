// src/services/voiceSettings/DbVoiceSettingsProvider.ts
import { eq } from "drizzle-orm";
import { languageVoiceSettings } from "../../db/schema.js";
import { VoiceNotConfiguredError, } from "../../interfaces/IvoiceSettingsProvider.js";
/** Reads language_voice_settings (edited in Settings / PUT /languages/:lang/voice-settings). */
export class DbVoiceSettingsProvider {
    db;
    constructor(db) {
        this.db = db;
    }
    async getSettings(language) {
        const [row] = await this.db.select().from(languageVoiceSettings).where(eq(languageVoiceSettings.targetLanguage, language)).limit(1);
        if (!row)
            throw new VoiceNotConfiguredError(language);
        return { language, voiceId: row.voiceId, modelId: row.modelId, voiceSettings: row.voiceSettings };
    }
}
//# sourceMappingURL=DbVoiceSettingsProvider.js.map