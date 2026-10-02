// src/services/catalog/getLocalizationCoverage.ts
import { and, count, countDistinct, eq, inArray } from "drizzle-orm";
import type { Database } from "../../db/client.js";
import { lessonSegments, segmentTranslations, ttsClips } from "../../db/schema.js";

export interface LanguageCoverage {
  language: string;
  /** Segments with a stored translation (for "en": every segment — the source is the text). */
  translated: number;
  /** Segments with an active clip that passed QC. */
  audioReady: number;
}

export interface LessonCoverage {
  segmentCount: number;
  languages: LanguageCoverage[];
}

/**
 * Read-only counts per lesson × language, in three grouped queries regardless
 * of lesson count. Only languages with any translation or clip appear;
 * callers treat a missing language as zero.
 */
export async function getLocalizationCoverage(
  db: Database,
  lessonIds: string[]
): Promise<Map<string, LessonCoverage>> {
  const result = new Map<string, LessonCoverage>();
  if (lessonIds.length === 0) return result;

  const [segmentCounts, translationCounts, audioCounts] = await Promise.all([
    db
      .select({ lessonId: lessonSegments.lessonId, n: count() })
      .from(lessonSegments)
      .where(inArray(lessonSegments.lessonId, lessonIds))
      .groupBy(lessonSegments.lessonId),
    db
      .select({ lessonId: lessonSegments.lessonId, language: segmentTranslations.targetLanguage, n: count() })
      .from(segmentTranslations)
      .innerJoin(lessonSegments, eq(segmentTranslations.segmentId, lessonSegments.id))
      .where(inArray(lessonSegments.lessonId, lessonIds))
      .groupBy(lessonSegments.lessonId, segmentTranslations.targetLanguage),
    db
      .select({ lessonId: lessonSegments.lessonId, language: ttsClips.language, n: countDistinct(ttsClips.segmentId) })
      .from(ttsClips)
      .innerJoin(lessonSegments, eq(ttsClips.segmentId, lessonSegments.id))
      .where(and(inArray(lessonSegments.lessonId, lessonIds), eq(ttsClips.qcStatus, "pass")))
      .groupBy(lessonSegments.lessonId, ttsClips.language),
  ]);

  for (const id of lessonIds) {
    result.set(id, { segmentCount: 0, languages: [] });
  }
  for (const row of segmentCounts) {
    result.get(row.lessonId)!.segmentCount = Number(row.n);
  }

  const languageEntry = (lessonId: string, language: string): LanguageCoverage => {
    const lesson = result.get(lessonId)!;
    let entry = lesson.languages.find((l) => l.language === language);
    if (!entry) {
      entry = { language, translated: language === "en" ? lesson.segmentCount : 0, audioReady: 0 };
      lesson.languages.push(entry);
    }
    return entry;
  };

  for (const row of translationCounts) {
    languageEntry(row.lessonId, row.language).translated = Number(row.n);
  }
  for (const row of audioCounts) {
    languageEntry(row.lessonId, row.language).audioReady = Number(row.n);
  }

  for (const lesson of result.values()) {
    lesson.languages.sort((a, b) => a.language.localeCompare(b.language));
  }
  return result;
}

/** Sums lesson coverage into course-level totals per language. */
export function sumCoverage(lessons: LessonCoverage[]): { segmentCount: number; languages: (LanguageCoverage & { lessonsComplete: number })[] } {
  const totals = new Map<string, LanguageCoverage & { lessonsComplete: number }>();
  let segmentCount = 0;
  for (const lesson of lessons) {
    segmentCount += lesson.segmentCount;
    for (const l of lesson.languages) {
      const t = totals.get(l.language) ?? { language: l.language, translated: 0, audioReady: 0, lessonsComplete: 0 };
      t.translated += l.translated;
      t.audioReady += l.audioReady;
      if (lesson.segmentCount > 0 && l.audioReady === lesson.segmentCount) t.lessonsComplete += 1;
      totals.set(l.language, t);
    }
  }
  return {
    segmentCount,
    languages: [...totals.values()].sort((a, b) => a.language.localeCompare(b.language)),
  };
}
