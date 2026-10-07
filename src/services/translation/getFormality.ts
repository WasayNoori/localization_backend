// src/services/translation/getFormality.ts
import { eq } from "drizzle-orm";
import type { Database } from "../../db/client.js";
import { languageTranslationSettings } from "../../db/schema.js";
import type { Formality } from "../../interfaces/ITranslationService.js";

/** The formality configured for a target language, if any (language_translation_settings). */
export async function getFormality(db: Database, targetLanguage: string): Promise<Formality | undefined> {
  const [row] = await db
    .select({ formality: languageTranslationSettings.formality })
    .from(languageTranslationSettings)
    .where(eq(languageTranslationSettings.targetLanguage, targetLanguage))
    .limit(1);
  return row?.formality as Formality | undefined;
}
