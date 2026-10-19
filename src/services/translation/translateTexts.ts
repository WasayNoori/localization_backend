// src/services/translation/translateTexts.ts
import type { Database } from "../../db/client.js";
import type { ITranslationService } from "../../interfaces/ITranslationService.js";
import type { Formality } from "../../interfaces/ITranslationService.js";
import { getFormality } from "./getFormality.js";
import { getGlossaryId } from "./getGlossaryId.js";
import { lengthWarning } from "./lengthCheck.js";

export interface TranslateTextsDeps {
  db: Database;
  translationService: ITranslationService;
}

export interface TranslateTextsResult {
  translatedTexts: string[];
  /** The glossary applied (snapshot onto stored rows), if the language has one. */
  glossaryId: string | undefined;
  /** The language's formality applied (snapshot onto stored rows), if one is set. */
  formality: Formality | undefined;
  /**
   * Per text (same order): why the translation still looks truncated after the
   * retries, or null. Callers flag these; segment audio isn't generated from them.
   */
  lengthWarnings: (string | null)[];
}

/**
 * The single way into DeepL for everything we translate — segments, course
 * scaffolding (course/section/lesson titles, descriptions) and ad-hoc
 * /translate. Always applies the target language's glossary, formality and an
 * English source; callers only decide the texts, the context and any custom
 * instructions (ambiguous terms). Callers never look
 * up glossaries or call ITranslationService directly (docs/decisions.md).
 */
export async function translateTexts(
  deps: TranslateTextsDeps,
  request: { texts: string[]; targetLanguage: string; context?: string; customInstructions?: string[] }
): Promise<TranslateTextsResult> {
  const [glossaryId, formality] = await Promise.all([
    getGlossaryId(deps.db, request.targetLanguage),
    getFormality(deps.db, request.targetLanguage),
  ]);
  if (request.texts.length === 0) return { translatedTexts: [], glossaryId, formality, lengthWarnings: [] };
  const call = (texts: string[], context: string | undefined) =>
    deps.translationService.translateMany({
      texts,
      targetLanguage: request.targetLanguage,
      sourceLanguage: "en",
      glossaryId,
      context,
      formality,
      customInstructions: request.customInstructions,
    });
  const { translatedTexts } = await call(request.texts, request.context);

  // Length check: a translation much shorter than its English is retried on its
  // own — once as sent, once without context — keeping the longest result.
  const warn = (i: number) => lengthWarning(request.texts[i], translatedTexts[i], request.targetLanguage);
  const lengthWarnings = request.texts.map((_, i) => warn(i));
  for (const [i, first] of lengthWarnings.entries()) {
    if (!first) continue;
    for (const context of [request.context, undefined]) {
      const [retry] = (await call([request.texts[i]], context)).translatedTexts;
      if (retry.length > translatedTexts[i].length) translatedTexts[i] = retry;
      lengthWarnings[i] = warn(i);
      if (!lengthWarnings[i]) break;
    }
  }
  return { translatedTexts, glossaryId, formality, lengthWarnings };
}
