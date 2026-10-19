// src/services/translation/translateLessonSegments.ts
import { and, eq, inArray, ne } from "drizzle-orm";
import type { Database } from "../../db/client.js";
import { lessons, segmentTranslations, ttsClips } from "../../db/schema.js";
import type { ITermSenseResolver } from "../../interfaces/ITermSenseResolver.js";
import { checkLessonTerms, type CheckTermsResult } from "../terms/checkLessonTerms.js";
import { loadLessonContext } from "./buildLessonContext.js";
import { translateAndStoreSegment } from "./translateAndStoreSegment.js";
import { translateLessonScaffoldingIfNeeded, type TranslateScaffoldingDeps } from "./translateScaffolding.js";

export interface TranslateLessonDeps extends TranslateScaffoldingDeps {
  /** When set, the lesson's ambiguous terms are checked (senses decided) before translating. */
  termSenseResolver?: ITermSenseResolver;
}

export interface TranslateLessonOptions {
  /** Restrict to these segments of the lesson (e.g. a UI multi-select). Default: every segment. */
  segmentIds?: string[];
}

export interface TranslateLessonResult {
  lessonId: string;
  targetLanguage: string;
  totalSegments: number;
  translated: string[];
  errors: { segmentId: string; error: string }[];
  /**
   * Segments whose active audio was spoken from a different text than the
   * translation now stored — regenerate with the generate endpoint + force.
   */
  audioStale: string[];
  /**
   * The lesson's name + description. On whole-lesson calls only (not when
   * segmentIds narrows the call), and only when missing or stale — current
   * titles are left to the course scaffolding command. `flagged` = Claude's
   * review flagged them; `error` = translation or review failed.
   */
  titles: { translated: boolean; flagged: boolean; error: string | null };
  /** Ambiguous-term check run before translating; null when no resolver was given. */
  terms: CheckTermsResult | null;
  /** Segments whose translation still looks truncated after the retries (stored, flagged, not voiced). */
  lengthWarnings: { segmentId: string; warning: string }[];
}

/**
 * "Translate this lesson": pushes every segment (or the selected ones)
 * through DeepL again with full-lesson context, overwriting existing
 * translations. A whole-lesson call also translates the lesson's name and
 * description. Text only — never touches tts_clips (same decoupling as
 * retranslateSegment). Per-segment and non-transactional: one failure is
 * recorded and the rest continue.
 */
export async function translateLessonSegments(
  deps: TranslateLessonDeps,
  lessonId: string,
  targetLanguage: string,
  options: TranslateLessonOptions = {}
): Promise<TranslateLessonResult> {
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

  // Senses for ambiguous terms first (language-independent; a no-op when already decided).
  const terms = deps.termSenseResolver
    ? await checkLessonTerms({ db, termSenseResolver: deps.termSenseResolver }, lessonId)
    : null;

  const translated: string[] = [];
  const errors: { segmentId: string; error: string }[] = [];
  const lengthWarnings: TranslateLessonResult["lengthWarnings"] = [];

  for (const [index, segment] of segments.entries()) {
    if (wanted && !wanted.has(segment.id)) continue;
    try {
      const r = await translateAndStoreSegment(deps, segment.id, segment.text, targetLanguage, context.forIndex(index));
      translated.push(segment.id);
      if (r.lengthWarning) lengthWarnings.push({ segmentId: segment.id, warning: r.lengthWarning });
    } catch (err) {
      errors.push({ segmentId: segment.id, error: err instanceof Error ? err.message : String(err) });
    }
  }

  const audioStale = await findStaleAudio(db, translated, targetLanguage);

  const titles: TranslateLessonResult["titles"] = { translated: false, flagged: false, error: null };
  if (!wanted) {
    try {
      // forIndex(0): the whole script, or the opening window when it exceeds
      // the DeepL request-size cap — same rule as segment translation.
      const r = await translateLessonScaffoldingIfNeeded(deps, lesson, targetLanguage, context.forIndex(0).text);
      titles.translated = r.translated;
      titles.flagged = r.review.flagged > 0;
      titles.error = r.review.error;
    } catch (err) {
      titles.error = err instanceof Error ? err.message : String(err);
    }
  }

  return { lessonId, targetLanguage, totalSegments: segments.length, translated, errors, audioStale, titles, terms, lengthWarnings };
}

export class TranslateLessonError extends Error {}

async function findStaleAudio(db: Database, segmentIds: string[], targetLanguage: string): Promise<string[]> {
  if (segmentIds.length === 0) return [];
  const rows = await db
    .select({ segmentId: ttsClips.segmentId, spoken: ttsClips.sentenceText, current: segmentTranslations.translatedText })
    .from(ttsClips)
    .innerJoin(
      segmentTranslations,
      and(eq(segmentTranslations.segmentId, ttsClips.segmentId), eq(segmentTranslations.targetLanguage, ttsClips.language))
    )
    .where(
      and(inArray(ttsClips.segmentId, segmentIds), eq(ttsClips.language, targetLanguage), ne(ttsClips.qcStatus, "superseded"))
    );
  return rows.filter((r) => r.spoken !== r.current).map((r) => r.segmentId);
}
