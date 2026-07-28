// src/services/generation/generateLocalizationForLesson.ts
import { and, desc, eq } from "drizzle-orm";
import type { Database } from "../../db/client.js";
import {
  lessonSegments,
  segmentTranslations,
  lessonLocalizations,
  languageVoiceSettings,
  ttsClips,
  type VoiceSettingsSnapshot,
} from "../../db/schema.js";
import type { ITranslationService } from "../../interfaces/ITranslationService.js";
import type { ITextToSpeechService } from "../../interfaces/ITextToSpeechService.js";
import type { IAudioQcService } from "../../interfaces/IAudioQcService.js";
import type { IFileStorageService } from "../../interfaces/IFileStorageService.js";
import type { IVoiceSettingsProvider } from "../../interfaces/IvoiceSettingsProvider.js";
import { findMissingSegments } from "./findMissingSegments.js";
import { translateAndStoreSegment } from "../translation/translateAndStoreSegment.js";

const AUDIO_FORMAT = "mp3_44100_128";
// Fixed rather than random: ElevenLabs seed reuse is best-effort only, but a
// shared constant across every clip is more useful for consistency than a
// different random value per call.
const TTS_SEED = 42;

export interface GenerateLocalizationDeps {
  db: Database;
  translationService: ITranslationService;
  ttsService: ITextToSpeechService;
  qcService: IAudioQcService;
  fileStorageService: IFileStorageService;
  voiceSettingsProvider: IVoiceSettingsProvider;
  /**
   * Box folder to upload generated clips into. Snapshotted onto the
   * lesson_localizations row the first time it's created for this
   * lesson+language, then reused from there on subsequent calls.
   */
  boxFolderId: string;
}

export interface GenerateLocalizationResult {
  lessonId: string;
  targetLanguage: string;
  totalSegments: number;
  missingSegments: number;
  succeeded: string[];
  errors: { segmentId: string; error: string }[];
}

export interface GenerateLocalizationOptions {
  /** Restrict processing to a single segment — for manual single-segment
   * regeneration/debugging, not just the normal find-what's-missing sweep. */
  segmentId?: string;
  /**
   * Verify each currently-"active" clip's Box file still exists before
   * trusting it, superseding + regenerating any that don't. Off by default:
   * it adds a Box API call per already-done segment, which defeats the
   * point of the missing-query being a cheap, DB-only check. Turn on when
   * Box/DB drift is actually suspected (e.g. a file was deleted out of band).
   */
  verifyBoxFiles?: boolean;
  /**
   * Force-regenerate every segment for this lesson+language, regardless of
   * whether it already has an active clip — supersedes all of them up
   * front (DB-only, no Box calls), then lets the normal missing-segment
   * loop handle every segment as if it were missing. Takes priority over
   * verifyBoxFiles (redundant once everything's being regenerated anyway).
   */
  force?: boolean;
}

/**
 * Resumes translation + audio generation for one lesson + target language.
 * Idempotent: it queries what's missing rather than tracking job state, so
 * re-invoking it after a partial failure just picks up where it left off.
 * Non-transactional per segment — one segment's failure is caught and
 * recorded, never blocking the rest. See docs/pipeline-flow.md for the
 * full query-loop writeup.
 * Basically, we give this a single lesson and it generates missing clips.
 */
export async function generateLocalizationForLesson(
  deps: GenerateLocalizationDeps,
  lessonId: string,
  targetLanguage: string,
  options: GenerateLocalizationOptions = {}
): Promise<GenerateLocalizationResult> {
  const { db } = deps;

  const { segments, activeClips } = await findMissingSegments(db, lessonId, targetLanguage);

  if (segments.length === 0) {
    return { lessonId, targetLanguage, totalSegments: 0, missingSegments: 0, succeeded: [], errors: [] };
  }

  const activeSegmentIds = new Set(activeClips.map((c) => c.segmentId));

  if (options.force) {
    // Regenerate everything regardless of current state — supersede every
    // active clip up front, DB-only, no Box calls. They flow into
    // missingSegments below through the exact same path as any other
    // missing segment, no separate "force regenerate" branch below.
    for (const clip of activeClips) {
      await db.update(ttsClips).set({ qcStatus: "superseded" }).where(eq(ttsClips.id, clip.id));
    }
    activeSegmentIds.clear();
  } else if (options.verifyBoxFiles) {
    for (const clip of activeClips) {
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

  const missingSegments = segments.filter(
    (s) => !activeSegmentIds.has(s.id) && (!options.segmentId || s.id === options.segmentId)
  );

  // For previous/next-segment stitching context — index into the full,
  // sequence-ordered segment list, not just the missing subset.
  const segmentIndexById = new Map(segments.map((s, index) => [s.id, index]));

  const voiceDefaults = await deps.voiceSettingsProvider.getSettings();
  const voiceSettingsRow = await getOrCreateLanguageVoiceSettings(deps, targetLanguage, voiceDefaults);
  const lessonLocalization = await getOrCreateLessonLocalization(deps, lessonId, targetLanguage);

  const succeeded: string[] = [];
  const errors: { segmentId: string; error: string }[] = [];

  for (const segment of missingSegments) {
    try {
      const text =
        targetLanguage === "en"
          ? segment.text
          : await resolveTranslatedText(deps, segment.id, segment.text, targetLanguage);

      const voiceId = voiceSettingsRow.voiceId;
      const modelId = voiceSettingsRow.modelId;
      const voiceSettings: VoiceSettingsSnapshot = voiceSettingsRow.voiceSettings;
      const seed = lessonLocalization.ttsSeed;

      const priorClip = await getLatestClip(db, segment.id, targetLanguage);
      const generationAttempt = priorClip ? priorClip.generationAttempt + 1 : 1;

      const segmentIndex = segmentIndexById.get(segment.id)!;
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
      const folderId = lessonLocalization.boxFolderId ?? deps.boxFolderId;
      const saved = await deps.fileStorageService.saveAudio(synthesized.audio, synthesized.requestId, folderId);

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
        boxFileId: saved.fileId,
        boxFilePath: saved.filePath,
        qcStatus: qc.passed ? "pass" : "fail",
        qcReport: qc,
        generationAttempt,
      });

      if (priorClip && qc.passed && priorClip.qcStatus !== "superseded") {
        await db.update(ttsClips).set({ qcStatus: "superseded" }).where(eq(ttsClips.id, priorClip.id));
      }

      succeeded.push(segment.id);
    } catch (err) {
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
  };
}

async function resolveTranslatedText(
  deps: GenerateLocalizationDeps,
  segmentId: string,
  englishText: string,
  targetLanguage: string
): Promise<string> {
  const { db } = deps;

  const [existing] = await db
    .select()
    .from(segmentTranslations)
    .where(and(eq(segmentTranslations.segmentId, segmentId), eq(segmentTranslations.targetLanguage, targetLanguage)))
    .limit(1);

  if (existing) {
    return existing.translatedText;
  }

  const { translatedText } = await translateAndStoreSegment(deps, segmentId, englishText, targetLanguage);
  return translatedText;
}

// Text for previous/next-segment stitching context. Never triggers a new
// DeepL call purely for context — English always has text available
// (lesson_segments.text); a translated neighbor only contributes context if
// it's already been translated, otherwise it's omitted.
async function resolveNeighborText(
  deps: GenerateLocalizationDeps,
  neighbor: typeof lessonSegments.$inferSelect | undefined,
  targetLanguage: string
): Promise<string | undefined> {
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

async function getOrCreateLessonLocalization(deps: GenerateLocalizationDeps, lessonId: string, targetLanguage: string) {
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

// Voice config is per-language, shared by every lesson — see
// docs/decisions.md. Bootstrapped from IVoiceSettingsProvider defaults the
// first time a language is ever generated; every lesson after that reuses
// the same row until PUT /languages/:targetLanguage/voice-settings changes
// it (see language-voice-settings.route.ts).
async function getOrCreateLanguageVoiceSettings(
  deps: GenerateLocalizationDeps,
  targetLanguage: string,
  voiceDefaults: { voiceId: string; modelId: string; voiceSettings: VoiceSettingsSnapshot }
) {
  const { db } = deps;

  const [existing] = await db
    .select()
    .from(languageVoiceSettings)
    .where(eq(languageVoiceSettings.targetLanguage, targetLanguage))
    .limit(1);

  if (existing) {
    return existing;
  }

  const [created] = await db
    .insert(languageVoiceSettings)
    .values({
      targetLanguage,
      voiceId: voiceDefaults.voiceId,
      modelId: voiceDefaults.modelId,
      voiceSettings: voiceDefaults.voiceSettings,
    })
    .returning();

  return created;
}

async function getLatestClip(db: Database, segmentId: string, language: string) {
  const [latest] = await db
    .select()
    .from(ttsClips)
    .where(and(eq(ttsClips.segmentId, segmentId), eq(ttsClips.language, language)))
    .orderBy(desc(ttsClips.generationAttempt))
    .limit(1);

  return latest ?? null;
}
