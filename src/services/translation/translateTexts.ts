// src/services/translation/translateTexts.ts
import type { Database } from "../../db/client.js";
import type { ITranslationService } from "../../interfaces/ITranslationService.js";
import { getGlossaryId } from "./getGlossaryId.js";

export interface TranslateTextsDeps {
  db: Database;
  translationService: ITranslationService;
}

export interface TranslateTextsResult {
  translatedTexts: string[];
  /** The glossary applied (snapshot onto stored rows), if the language has one. */
  glossaryId: string | undefined;
}

/**
 * The single way into DeepL for everything we translate — segments, course
 * scaffolding (course/section/lesson titles, descriptions) and ad-hoc
 * /translate. Always applies the target language's glossary and an English
 * source; callers only decide the texts and the context. Callers never look
 * up glossaries or call ITranslationService directly (docs/decisions.md).
 */
export async function translateTexts(
  deps: TranslateTextsDeps,
  request: { texts: string[]; targetLanguage: string; context?: string }
): Promise<TranslateTextsResult> {
  const glossaryId = await getGlossaryId(deps.db, request.targetLanguage);
  if (request.texts.length === 0) return { translatedTexts: [], glossaryId };
  const { translatedTexts } = await deps.translationService.translateMany({
    texts: request.texts,
    targetLanguage: request.targetLanguage,
    sourceLanguage: "en",
    glossaryId,
    context: request.context,
  });
  return { translatedTexts, glossaryId };
}
