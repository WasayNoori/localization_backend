// src/services/translation/translateAndStoreSegment.ts
import type { Database } from "../../db/client.js";
import { segmentTranslations } from "../../db/schema.js";
import type { ITranslationService } from "../../interfaces/ITranslationService.js";
import { translateTexts } from "./translateTexts.js";
import type { TranslationContext } from "./buildLessonContext.js";

export interface TranslateAndStoreDeps {
  db: Database;
  translationService: ITranslationService;
}

export interface TranslateAndStoreResult {
  translatedText: string;
}

/**
 * Calls DeepL (with this target language's glossary and formality, if any, and the lesson
 * context) and writes the segment_translations row — overwriting any
 * existing row for this segment+language. Whether an existing row should be
 * reused instead (generate-stage resume) is the caller's decision.
 */
export async function translateAndStoreSegment(
  deps: TranslateAndStoreDeps,
  segmentId: string,
  englishText: string,
  targetLanguage: string,
  context?: TranslationContext
): Promise<TranslateAndStoreResult> {
  const { db } = deps;

  const {
    translatedTexts: [translatedText],
    glossaryId,
    formality,
  } = await translateTexts(deps, { texts: [englishText], targetLanguage, context: context?.text });
  const result = { translatedText };

  const values = {
    translatedText: result.translatedText,
    deeplGlossaryId: glossaryId ?? null,
    contextUsed: context?.descriptor ?? null,
    formality: formality ?? null,
    billedCharacters: null,
    // No updated_at column: created_at records when THIS translation was produced.
    createdAt: new Date(),
  };

  await db
    .insert(segmentTranslations)
    .values({ segmentId, targetLanguage, ...values })
    .onConflictDoUpdate({
      target: [segmentTranslations.segmentId, segmentTranslations.targetLanguage],
      set: values,
    });

  return { translatedText: result.translatedText };
}
