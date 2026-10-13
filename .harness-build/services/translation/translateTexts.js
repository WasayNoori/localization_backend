import { getFormality } from "./getFormality.js";
import { getGlossaryId } from "./getGlossaryId.js";
/**
 * The single way into DeepL for everything we translate — segments, course
 * scaffolding (course/section/lesson titles, descriptions) and ad-hoc
 * /translate. Always applies the target language's glossary, formality and an
 * English source; callers only decide the texts and the context. Callers never look
 * up glossaries or call ITranslationService directly (docs/decisions.md).
 */
export async function translateTexts(deps, request) {
    const [glossaryId, formality] = await Promise.all([
        getGlossaryId(deps.db, request.targetLanguage),
        getFormality(deps.db, request.targetLanguage),
    ]);
    if (request.texts.length === 0)
        return { translatedTexts: [], glossaryId, formality };
    const { translatedTexts } = await deps.translationService.translateMany({
        texts: request.texts,
        targetLanguage: request.targetLanguage,
        sourceLanguage: "en",
        glossaryId,
        context: request.context,
        formality,
    });
    return { translatedTexts, glossaryId, formality };
}
//# sourceMappingURL=translateTexts.js.map