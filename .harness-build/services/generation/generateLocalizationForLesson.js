// src/services/generation/generateLocalizationForLesson.ts
import { and, desc, eq } from "drizzle-orm";
import { segmentTranslations, lessonLocalizations, ttsClips, } from "../../db/schema.js";
import { findMissingSegments } from "./findMissingSegments.js";
import { translateAndStoreSegment } from "../translation/translateAndStoreSegment.js";
import { buildLessonContext } from "../translation/buildLessonContext.js";
const AUDIO_FORMAT = "mp3_44100_192";
// Fixed rather than random: ElevenLabs seed reuse is best-effort only, but a
// shared constant across every clip is more useful for consistency than a
// different random value per call.
const TTS_SEED = 42;
/**
 * Resumes translation + audio generation for one lesson + target language.
 * Idempotent: it queries what's missing rather than tracking job state, so
 * re-invoking it after a partial failure just picks up where it left off.
 * Non-transactional per segment — one segment's failure is caught and
 * recorded, never blocking the rest. See docs/pipeline-flow.md for the
 * full query-loop writeup.
 * Basically, we give this a single lesson and it generates missing clips.
 */
export async function generateLocalizationForLesson(deps, lessonId, targetLanguage, options = {}) {
    const { db } = deps;
    const { segments, activeClips } = await findMissingSegments(db, lessonId, targetLanguage);
    if (segments.length === 0) {
        return { lessonId, targetLanguage, totalSegments: 0, missingSegments: 0, succeeded: [], errors: [] };
    }
    const activeSegmentIds = new Set(activeClips.map((c) => c.segmentId));
    // force/verifyBoxFiles act only on the segments in scope: with segmentId,
    // just that one segment's clip — never the rest of the lesson's audio.
    const clipsInScope = options.segmentId
        ? activeClips.filter((c) => c.segmentId === options.segmentId)
        : activeClips;
    if (options.force) {
        // Regenerate everything in scope regardless of current state — supersede
        // those active clips up front, DB-only, no Box calls. They flow into
        // missingSegments below through the exact same path as any other
        // missing segment, no separate "force regenerate" branch below.
        for (const clip of clipsInScope) {
            await db.update(ttsClips).set({ qcStatus: "superseded" }).where(eq(ttsClips.id, clip.id));
            activeSegmentIds.delete(clip.segmentId);
        }
    }
    else if (options.verifyBoxFiles) {
        if (!deps.fileStorageService)
            throw new Error("verifyBoxFiles needs a file storage service");
        for (const clip of clipsInScope) {
            if (!clip.boxFileId) {
                continue;
            }
            const exists = await deps.fileStorageService.fileExists(clip.boxFileId);
            if (!exists) {
                // Supersede the stale row and drop it from the active set — it now
                // flows into missingSegments below and regenerates through the
                // exact same per-segment loop as everything else, no separate path.
                await db.update(ttsClips).set({ qcStatus: "superseded" }).where(eq(ttsClips.id, clip.id));
                activeSegmentIds.delete(clip.segmentId);
            }
        }
    }
    const missingSegments = segments.filter((s) => !activeSegmentIds.has(s.id) && (!options.segmentId || s.id === options.segmentId));
    // For previous/next-segment stitching context — index into the full,
    // sequence-ordered segment list, not just the missing subset.
    const segmentIndexById = new Map(segments.map((s, index) => [s.id, index]));
    const lessonContext = buildLessonContext(segments);
    // Throws VoiceNotConfiguredError for a language without a voice — never a silent default.
    const voiceSettingsRow = await deps.voiceSettingsProvider.getSettings(targetLanguage);
    const lessonLocalization = await getOrCreateLessonLocalization(deps, lessonId, targetLanguage);
    const succeeded = [];
    const errors = [];
    let stopped = false;
    for (const segment of missingSegments) {
        if (options.shouldStop?.()) {
            stopped = true;
            break;
        }
        try {
            const text = targetLanguage === "en"
                ? segment.text
                : await resolveTranslatedText(deps, segment.id, segment.text, targetLanguage, lessonContext.forIndex(segmentIndexById.get(segment.id)));
            const voiceId = voiceSettingsRow.voiceId;
            const modelId = voiceSettingsRow.modelId;
            const voiceSettings = voiceSettingsRow.voiceSettings;
            const seed = lessonLocalization.ttsSeed;
            const priorClip = await getLatestClip(db, segment.id, targetLanguage);
            const generationAttempt = priorClip ? priorClip.generationAttempt + 1 : 1;
            const segmentIndex = segmentIndexById.get(segment.id);
            const previousText = await resolveNeighborText(deps, segments[segmentIndex - 1], targetLanguage);
            const nextText = await resolveNeighborText(deps, segments[segmentIndex + 1], targetLanguage);
            const synthesized = await deps.ttsService.synthesize({
                text,
                voiceId,
                modelId,
                voiceSettings,
                seed,
                previousText,
                nextText,
                outputFormat: AUDIO_FORMAT,
            });
            const qc = await deps.qcService.check(synthesized.audio);
            const saved = await deps.clipStore.save({
                lessonId,
                language: targetLanguage,
                segmentNumber: segmentIndex + 1,
                requestId: synthesized.requestId,
                // The course's Box folder is the source of truth; the lesson row's snapshot is a fallback.
                boxFolderId: deps.boxFolderId ?? lessonLocalization.boxFolderId,
                courseFolder: deps.courseFolder ?? null,
            }, synthesized.audio);
            await db.insert(ttsClips).values({
                segmentId: segment.id,
                language: targetLanguage,
                lessonLocalizationId: lessonLocalization.id,
                templateId: null,
                sentenceText: text,
                requestId: synthesized.requestId,
                seed,
                voiceId,
                modelId,
                voiceSettings,
                audioFormat: AUDIO_FORMAT,
                boxFileId: saved.boxFileId,
                boxFilePath: saved.boxFilePath,
                localPath: saved.localPath,
                previousText: previousText ?? null,
                nextText: nextText ?? null,
                qcStatus: qc.passed ? "pass" : "fail",
                qcReport: qc,
                generationAttempt,
            });
            if (priorClip && qc.passed && priorClip.qcStatus !== "superseded") {
                await db.update(ttsClips).set({ qcStatus: "superseded" }).where(eq(ttsClips.id, priorClip.id));
            }
            succeeded.push(segment.id);
        }
        catch (err) {
            errors.push({ segmentId: segment.id, error: err instanceof Error ? err.message : String(err) });
        }
    }
    return {
        lessonId,
        targetLanguage,
        totalSegments: segments.length,
        missingSegments: missingSegments.length,
        succeeded,
        errors,
        stopped,
    };
}
async function resolveTranslatedText(deps, segmentId, englishText, targetLanguage, context) {
    const { db } = deps;
    const [existing] = await db
        .select()
        .from(segmentTranslations)
        .where(and(eq(segmentTranslations.segmentId, segmentId), eq(segmentTranslations.targetLanguage, targetLanguage)))
        .limit(1);
    if (existing) {
        return existing.translatedText;
    }
    const { translatedText } = await translateAndStoreSegment(deps, segmentId, englishText, targetLanguage, context);
    return translatedText;
}
// Text for previous/next-segment stitching context. Never triggers a new
// DeepL call purely for context — English always has text available
// (lesson_segments.text); a translated neighbor only contributes context if
// it's already been translated, otherwise it's omitted.
async function resolveNeighborText(deps, neighbor, targetLanguage) {
    if (!neighbor) {
        return undefined;
    }
    if (targetLanguage === "en") {
        return neighbor.text;
    }
    const [existing] = await deps.db
        .select()
        .from(segmentTranslations)
        .where(and(eq(segmentTranslations.segmentId, neighbor.id), eq(segmentTranslations.targetLanguage, targetLanguage)))
        .limit(1);
    return existing?.translatedText;
}
async function getOrCreateLessonLocalization(deps, lessonId, targetLanguage) {
    const { db } = deps;
    const [existing] = await db
        .select()
        .from(lessonLocalizations)
        .where(and(eq(lessonLocalizations.lessonId, lessonId), eq(lessonLocalizations.targetLanguage, targetLanguage)))
        .limit(1);
    if (existing) {
        return existing;
    }
    const [created] = await db
        .insert(lessonLocalizations)
        .values({
        lessonId,
        targetLanguage,
        ttsSeed: TTS_SEED,
        boxFolderId: deps.boxFolderId,
        status: "in_progress",
    })
        .returning();
    return created;
}
async function getLatestClip(db, segmentId, language) {
    const [latest] = await db
        .select()
        .from(ttsClips)
        .where(and(eq(ttsClips.segmentId, segmentId), eq(ttsClips.language, language)))
        .orderBy(desc(ttsClips.generationAttempt))
        .limit(1);
    return latest ?? null;
}
//# sourceMappingURL=generateLocalizationForLesson.js.map