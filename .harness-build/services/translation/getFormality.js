// src/services/translation/getFormality.ts
import { eq } from "drizzle-orm";
import { languageTranslationSettings } from "../../db/schema.js";
/** The formality configured for a target language, if any (language_translation_settings). */
export async function getFormality(db, targetLanguage) {
    const [row] = await db
        .select({ formality: languageTranslationSettings.formality })
        .from(languageTranslationSettings)
        .where(eq(languageTranslationSettings.targetLanguage, targetLanguage))
        .limit(1);
    return row?.formality;
}
//# sourceMappingURL=getFormality.js.map