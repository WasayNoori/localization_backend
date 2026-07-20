// src/services/generation/generateLocalizationForLesson.ts
import { and, desc, eq, inArray, ne } from "drizzle-orm";
import type { Database } from "../../db/client.js";
import {
  lessonSegments,
  segmentTranslations,
  lessonLocalizations,
  glossaries,
  ttsClips,
  type VoiceSettingsSnapshot,
} from "../../db/schema.js";
import type { ITranslationService } from "../../interfaces/ITranslationService.js";
import type { ITextToSpeechService } from "../../interfaces/ITextToSpeechService.js";
import type { IAudioQcService } from "../../interfaces/IAudioQcService.js";
import type { IFileStorageService } from "../../interfaces/IFileStorageService.js";
import type { IVoiceSettingsProvider } from "../../interfaces/IvoiceSettingsProvider.js";

const AUDIO_FORMAT = "mp3_44100_128";

export interface GenerateLocalizationDeps {
  db: Database;
  translationService: ITranslationService;
  ttsService: ITextToSpeechService;
  qcService: IAudioQcService;
  fileStorageService: IFileStorageService;
  voiceSettingsProvider: IVoiceSettingsProvider;
}

export interface GenerateLocalizationResult {
  lessonId: string;
  targetLanguage: string;
  totalSegments: number;
  missingSegments: number;
  succeeded: string[];
  errors: { segmentId: string; error: string }[];
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
  targetLanguage: string
): Promise<GenerateLocalizationResult> {
  const { db } = deps;

  const segments = await db
    .select()
    .from(lessonSegments)
    .where(eq(lessonSegments.lessonId, lessonId))
    .orderBy(lessonSegments.sequenceIndex);

  if (segments.length === 0) {
    return { lessonId, targetLanguage, totalSegments: 0, missingSegments: 0, succeeded: [], errors: [] };
  }

  const segmentIds = segments.map((s) => s.id);

  // "Active" mirrors the tts_clips partial unique index: any row whose
  // qc_status isn't 'superseded' already satisfies this segment+language.
  const activeClips = await db
    .select({ segmentId: ttsClips.segmentId })
    .from(ttsClips)
    .where(
      and(
        inArray(ttsClips.segmentId, segmentIds),
        eq(ttsClips.language, targetLanguage),
        ne(ttsClips.qcStatus, "superseded")
      )
    );
  const activeSegmentIds = new Set(activeClips.map((c) => c.segmentId));

  const missingSegments = segments.filter((s) => !activeSegmentIds.has(s.id));

  const voiceDefaults = await deps.voiceSettingsProvider.getSettings();
  const lessonLocalization =
    targetLanguage === "en" ? null : await getOrCreateLessonLocalization(deps, lessonId, targetLanguage, voiceDefaults);

  const succeeded: string[] = [];
  const errors: { segmentId: string; error: string }[] = [];

  for (const segment of missingSegments) {
    try {
      const text =
        targetLanguage === "en"
          ? segment.text
          : await resolveTranslatedText(deps, segment.id, segment.text, targetLanguage);

      const voiceId = lessonLocalization?.voiceId ?? voiceDefaults.voiceId;
      const modelId = lessonLocalization?.modelId ?? voiceDefaults.modelId;
      const voiceSettings: VoiceSettingsSnapshot = lessonLocalization?.defaultVoiceSettings ?? voiceDefaults.voiceSettings;
      const seed = lessonLocalization?.ttsSeed ?? randomSeed();

      const priorClip = await getLatestClip(db, segment.id, targetLanguage);
      const generationAttempt = priorClip ? priorClip.generationAttempt + 1 : 1;

      const synthesized = await deps.ttsService.synthesize({
        text,
        voiceId,
        modelId,
        voiceSettings,
        seed,
        outputFormat: AUDIO_FORMAT,
      });

      const qc = await deps.qcService.check(synthesized.audio);
      const saved = await deps.fileStorageService.saveAudio(synthesized.audio, synthesized.requestId);

      await db.insert(ttsClips).values({
        segmentId: segment.id,
        language: targetLanguage,
        lessonLocalizationId: lessonLocalization?.id ?? null,
        templateId: null,
        sentenceText: text,
        requestId: synthesized.requestId,
        seed,
        voiceId,
        modelId,
        voiceSettings,
        audioFormat: AUDIO_FORMAT,
        boxFileId: null,
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

  const [glossary] = await db
    .select()
    .from(glossaries)
    .where(eq(glossaries.targetLanguage, targetLanguage))
    .limit(1);

  const result = await deps.translationService.translate({
    text: englishText,
    targetLanguage,
    glossaryId: glossary?.deeplGlossaryId,
  });

  await db.insert(segmentTranslations).values({
    segmentId,
    targetLanguage,
    translatedText: result.translatedText,
    deeplGlossaryId: glossary?.deeplGlossaryId ?? null,
    contextUsed: null,
    billedCharacters: null,
  });

  return result.translatedText;
}

async function getOrCreateLessonLocalization(
  deps: GenerateLocalizationDeps,
  lessonId: string,
  targetLanguage: string,
  voiceDefaults: { voiceId: string; modelId: string; voiceSettings: VoiceSettingsSnapshot }
) {
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
      voiceId: voiceDefaults.voiceId,
      modelId: voiceDefaults.modelId,
      ttsSeed: randomSeed(),
      defaultVoiceSettings: voiceDefaults.voiceSettings,
      boxFolderId: null,
      status: "in_progress",
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

function randomSeed(): number {
  return Math.floor(Math.random() * 2 ** 31);
}
