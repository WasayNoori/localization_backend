// src/services/translation/translateCourseLessons.ts
import { and, asc, eq, inArray } from "drizzle-orm";
import type { Database } from "../../db/client.js";
import { courseLessons, courseSections, courses, lessonSegments, segmentTranslations } from "../../db/schema.js";
import { getFormality } from "./getFormality.js";
import { translateLessonSegments, type TranslateLessonDeps } from "./translateLessonSegments.js";

/**
 * missing: only segments with no translation in this language, or translated
 * under a different formality than the language's current setting (stale).
 * all: every segment again.
 */
export type CourseTranslationMode = "missing" | "all";

export interface CourseTranslationProgress {
  total: number;
  /** Lessons translated in this run (fully, or their missing segments). */
  succeeded: string[];
  /** Lessons where at least one segment failed — the rest of the lesson is saved. */
  failed: { lessonId: string; error: string }[];
  /** Lessons left alone: not parsed yet, or nothing missing (mode "missing"). */
  skipped: { lessonId: string; reason: string }[];
}

export class TranslateCourseError extends Error {
  constructor(
    public readonly statusCode: 400 | 404,
    message: string
  ) {
    super(message);
  }
}

export interface TranslateCourseOptions {
  mode?: CourseTranslationMode;
  /** Called after each lesson with the running totals (job progress, CLI output). */
  onProgress?: (progress: CourseTranslationProgress, lessonId: string) => void | Promise<void>;
  /** Checked before each lesson; true = stop early (CLI time budget). Re-run with "missing" to continue. */
  shouldStop?: () => boolean;
}

/**
 * Course-level fan-out over the existing lesson translation
 * (translateLessonSegments) — never reimplements per-lesson logic. Lessons
 * run one at a time in course order; a lesson's failure is recorded and the
 * run continues. Resumable: with mode "missing", lessons whose segments are
 * all translated are skipped, so re-running after an interruption picks up
 * where it stopped.
 */
export async function translateCourseLessons(
  deps: TranslateLessonDeps,
  courseId: string,
  targetLanguage: string,
  options: TranslateCourseOptions = {}
): Promise<CourseTranslationProgress & { stopped: boolean }> {
  const { db } = deps;
  const mode = options.mode ?? "missing";
  await assertTranslatableCourse(db, courseId, targetLanguage);

  const ordered = await courseLessonOrder(db, courseId);

  const progress: CourseTranslationProgress = { total: ordered.length, succeeded: [], failed: [], skipped: [] };
  for (const lessonId of ordered) {
    if (options.shouldStop?.()) return { ...progress, stopped: true };

    const { all, untranslated } = await segmentState(db, lessonId, targetLanguage);
    if (all.length === 0) {
      progress.skipped.push({ lessonId, reason: "not parsed" });
    } else if (mode === "missing" && untranslated.length === 0) {
      progress.skipped.push({ lessonId, reason: "already translated" });
    } else {
      try {
        // Whole-lesson call when everything is wanted (also fills missing lesson
        // titles); only the missing segments otherwise.
        const partial = mode === "missing" && untranslated.length < all.length;
        const result = await translateLessonSegments(deps, lessonId, targetLanguage, partial ? { segmentIds: untranslated } : {});
        if (result.errors.length) {
          progress.failed.push({
            lessonId,
            error: `${result.errors.length} of ${result.totalSegments} segments failed: ${result.errors[0].error}`,
          });
        } else {
          progress.succeeded.push(lessonId);
        }
      } catch (err) {
        progress.failed.push({ lessonId, error: err instanceof Error ? err.message : String(err) });
      }
    }
    await options.onProgress?.(progress, lessonId);
  }
  return { ...progress, stopped: false };
}

export async function assertTranslatableCourse(db: Database, courseId: string, targetLanguage: string): Promise<void> {
  if (targetLanguage === "en") throw new TranslateCourseError(400, `"en" is the source language — nothing to translate`);
  const [course] = await db.select({ id: courses.id }).from(courses).where(eq(courses.id, courseId)).limit(1);
  if (!course) throw new TranslateCourseError(404, `No course with id "${courseId}"`);
}

/** Lesson ids in display order: section index, then position (unsectioned last). */
export async function courseLessonOrder(db: Database, courseId: string): Promise<string[]> {
  const rows = await db
    .select({ lessonId: courseLessons.lessonId, sectionIndex: courseSections.sectionIndex, position: courseLessons.position })
    .from(courseLessons)
    .leftJoin(courseSections, eq(courseLessons.sectionId, courseSections.id))
    .where(eq(courseLessons.courseId, courseId))
    .orderBy(asc(courseSections.sectionIndex), asc(courseLessons.position), asc(courseLessons.lessonId));
  return rows.map((r) => r.lessonId);
}

async function segmentState(db: Database, lessonId: string, targetLanguage: string) {
  const all = await db.select({ id: lessonSegments.id }).from(lessonSegments).where(eq(lessonSegments.lessonId, lessonId));
  if (!all.length) return { all, untranslated: [] as string[] };
  const formality = (await getFormality(db, targetLanguage)) ?? null;
  const done = new Set(
    (
      await db
        .select({ segmentId: segmentTranslations.segmentId, formality: segmentTranslations.formality })
        .from(segmentTranslations)
        .where(
          and(
            eq(segmentTranslations.targetLanguage, targetLanguage),
            inArray(segmentTranslations.segmentId, all.map((s) => s.id))
          )
        )
    )
      // A translation made under a different formality is stale — redo it.
      .filter((r) => r.formality === formality)
      .map((r) => r.segmentId)
  );
  return { all, untranslated: all.map((s) => s.id).filter((id) => !done.has(id)) };
}
