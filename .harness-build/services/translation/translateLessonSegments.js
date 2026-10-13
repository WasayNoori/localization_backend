// src/services/translation/translateLessonSegments.ts
import { and, eq, inArray, ne } from "drizzle-orm";
import { lessons, segmentTranslations, ttsClips } from "../../db/schema.js";
import { loadLessonContext } from "./buildLessonContext.js";
import { translateAndStoreSegment } from "./translateAndStoreSegment.js";
import { translateLessonScaffoldingIfNeeded } from "./translateScaffolding.js";
/**
 * "Translate this lesson": pushes every segment (or the selected ones)
 * through DeepL again with full-lesson context, overwriting existing
 * translations. A whole-lesson call also translates the lesson's name and
 * description. Text only — never touches tts_clips (same decoupling as
 * retranslateSegment). Per-segment and non-transactional: one failure is
 * recorded and the rest continue.
 */
export async function translateLessonSegments(deps, lessonId, targetLanguage, options = {}) {
    const { db } = deps;
    if (targetLanguage === "en") {
        throw new TranslateLessonError(`"en" is the source language — nothing to translate`);
    }
    const [lesson] = await db.select().from(lessons).where(eq(lessons.id, lessonId)).limit(1);
    if (!lesson) {
        throw new TranslateLessonError(`No lesson with id "${lessonId}"`);
    }
    const { segments, context } = await loadLessonContext(db, lessonId);
    if (segments.length === 0) {
        throw new TranslateLessonError(`Lesson "${lessonId}" has no segments — parse it first`);
    }
    const wanted = options.segmentIds ? new Set(options.segmentIds) : null;
    if (wanted) {
        const unknown = [...wanted].filter((id) => !segments.some((s) => s.id === id));
        if (unknown.length) {
            throw new TranslateLessonError(`Segments not in lesson "${lessonId}": ${unknown.join(", ")}`);
        }
    }
    const translated = [];
    const errors = [];
    for (const [index, segment] of segments.entries()) {
        if (wanted && !wanted.has(segment.id))
            continue;
        try {
            await translateAndStoreSegment(deps, segment.id, segment.text, targetLanguage, context.forIndex(index));
            translated.push(segment.id);
        }
        catch (err) {
            errors.push({ segmentId: segment.id, error: err instanceof Error ? err.message : String(err) });
        }
    }
    const audioStale = await findStaleAudio(db, translated, targetLanguage);
    const titles = { translated: false, flagged: false, error: null };
    if (!wanted) {
        try {
            // forIndex(0): the whole script, or the opening window when it exceeds
            // the DeepL request-size cap — same rule as segment translation.
            const r = await translateLessonScaffoldingIfNeeded(deps, lesson, targetLanguage, context.forIndex(0).text);
            titles.translated = r.translated;
            titles.flagged = r.review.flagged > 0;
            titles.error = r.review.error;
        }
        catch (err) {
            titles.error = err instanceof Error ? err.message : String(err);
        }
    }
    return { lessonId, targetLanguage, totalSegments: segments.length, translated, errors, audioStale, titles };
}
export class TranslateLessonError extends Error {
}
async function findStaleAudio(db, segmentIds, targetLanguage) {
    if (segmentIds.length === 0)
        return [];
    const rows = await db
        .select({ segmentId: ttsClips.segmentId, spoken: ttsClips.sentenceText, current: segmentTranslations.translatedText })
        .from(ttsClips)
        .innerJoin(segmentTranslations, and(eq(segmentTranslations.segmentId, ttsClips.segmentId), eq(segmentTranslations.targetLanguage, ttsClips.language)))
        .where(and(inArray(ttsClips.segmentId, segmentIds), eq(ttsClips.language, targetLanguage), ne(ttsClips.qcStatus, "superseded")));
    return rows.filter((r) => r.spoken !== r.current).map((r) => r.segmentId);
}
//# sourceMappingURL=translateLessonSegments.js.map