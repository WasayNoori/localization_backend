// src/services/translation/translateAndStoreSegment.ts
import type { Database } from "../../db/client.js";
import { segmentTranslations } from "../../db/schema.js";
import type { ITranslationService } from "../../interfaces/ITranslationService.js";
import { getGlossaryId } from "./getGlossaryId.js";

export interface TranslateAndStoreDeps {
  db: Database;
  translationService: ITranslationService;
}

export interface TranslateAndStoreResult {
  translatedText: string;
}

/**
 * Calls DeepL (with this target language's glossary, if any) and inserts a
 * fresh segment_translations row. Always inserts — whether an existing row
 * should be reused instead (generate-stage resume) or replaced first
 * (retranslateSegment) is the caller's decision, not this function's.
 */
export async function translateAndStoreSegment(
  deps: TranslateAndStoreDeps,
  segmentId: string,
  englishText: string,
  targetLanguage: string
): Promise<TranslateAndStoreResult> {
  const { db } = deps;

  const glossaryId = await getGlossaryId(db, targetLanguage);

  const result = await deps.translationService.translate({
    text: englishText,
    targetLanguage,
    glossaryId,
  });

  await db.insert(segmentTranslations).values({
    segmentId,
    targetLanguage,
    translatedText: result.translatedText,
    deeplGlossaryId: glossaryId ?? null,
    contextUsed: null,
    billedCharacters: null,
  });

  return { translatedText: result.translatedText };
}
