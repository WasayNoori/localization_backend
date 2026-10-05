// src/services/catalog/getLessonLocalization.ts
import { and, asc, desc, eq, inArray, ne } from "drizzle-orm";
import type { Database } from "../../db/client.js";
import { lessons, lessonSegments, lessonTranslations, segmentTranslations, ttsClips } from "../../db/schema.js";
import { lessonTitlesStale } from "../translation/translateCatalogTitles.js";

export type SegmentLocalizationStatus = "not_translated" | "translated" | "audio_ready" | "qc_failed";

export interface SegmentLocalization {
  id: string;
  sequenceIndex: number;
  sourceText: string;
  /** Null when not translated yet. For "en" this is the source text itself. */
  translation: { text: string; translatedAt: Date | null; contextUsed: string | null } | null;
  /** The current (non-superseded) clip, if any. */
  clip: { id: string; qcStatus: string; qcIssues: string[]; createdAt: Date; generationAttempt: number } | null;
  status: SegmentLocalizationStatus;
  /** The clip was spoken from different text than the current translation. */
  audioStale: boolean;
}

export interface LessonLocalization {
  lesson: {
    id: string;
    lessonName: string;
    description: string | null;
    hasScript: boolean;
    parsedAt: Date | null;
    parseStale: boolean;
    tags: string[];
    /** The lesson's name/description in this language; null if not translated (always null for "en"). */
    translation: { lessonName: string; description: string | null; stale: boolean } | null;
  };
  language: string;
  segments: SegmentLocalization[];
}

/**
 * Read-only: one lesson's segments side by side with their translation and
 * current clip in one language, with a derived per-segment status. Null if
 * the lesson doesn't exist.
 */
export async function getLessonLocalization(
  db: Database,
  lessonId: string,
  language: string
): Promise<LessonLocalization | null> {
  const [lesson] = await db.select().from(lessons).where(eq(lessons.id, lessonId)).limit(1);
  if (!lesson) return null;

  const segments = await db
    .select()
    .from(lessonSegments)
    .where(eq(lessonSegments.lessonId, lessonId))
    .orderBy(asc(lessonSegments.sequenceIndex));
  const segmentIds = segments.map((s) => s.id);
  const [titleRow] = await db
    .select()
    .from(lessonTranslations)
    .where(and(eq(lessonTranslations.lessonId, lessonId), eq(lessonTranslations.targetLanguage, language)))
    .limit(1);

  const [translations, clips] = segmentIds.length
    ? await Promise.all([
        db
          .select()
          .from(segmentTranslations)
          .where(and(inArray(segmentTranslations.segmentId, segmentIds), eq(segmentTranslations.targetLanguage, language))),
        db
          .select()
          .from(ttsClips)
          .where(and(inArray(ttsClips.segmentId, segmentIds), eq(ttsClips.language, language), ne(ttsClips.qcStatus, "superseded")))
          .orderBy(desc(ttsClips.createdAt)),
      ])
    : [[], []];

  const translationBySegment = new Map(translations.map((t) => [t.segmentId, t]));
  const clipBySegment = new Map<string, (typeof clips)[number]>();
  for (const clip of clips) {
    if (!clipBySegment.has(clip.segmentId)) clipBySegment.set(clip.segmentId, clip); // newest first
  }

  return {
    lesson: {
      id: lesson.id,
      lessonName: lesson.lessonName,
      description: lesson.description,
      hasScript: lesson.scriptText !== null || lesson.boxFileId !== null,
      parsedAt: lesson.parsedAt,
      parseStale: !!(lesson.parsedAt && lesson.scriptUpdatedAt && lesson.scriptUpdatedAt > lesson.parsedAt),
      tags: lesson.tags,
      translation: titleRow
        ? { lessonName: titleRow.lessonName, description: titleRow.description, stale: lessonTitlesStale(titleRow, lesson) }
        : null,
    },
    language,
    segments: segments.map((s) => {
      const t = translationBySegment.get(s.id);
      const translation =
        language === "en"
          ? { text: s.text, translatedAt: null, contextUsed: null }
          : t
            ? { text: t.translatedText, translatedAt: t.createdAt, contextUsed: t.contextUsed }
            : null;
      const c = clipBySegment.get(s.id);
      const clip = c
        ? { id: c.id, qcStatus: c.qcStatus, qcIssues: c.qcReport?.issues ?? [], createdAt: c.createdAt, generationAttempt: c.generationAttempt }
        : null;
      const status: SegmentLocalizationStatus = !translation
        ? "not_translated"
        : c?.qcStatus === "pass"
          ? "audio_ready"
          : c?.qcStatus === "fail"
            ? "qc_failed"
            : "translated";
      return {
        id: s.id,
        sequenceIndex: s.sequenceIndex,
        sourceText: s.text,
        translation,
        clip,
        status,
        audioStale: !!(c && translation && c.sentenceText !== translation.text),
      };
    }),
  };
}
