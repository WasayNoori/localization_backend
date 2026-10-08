// src/services/generation/generateCourseAudio.ts
import { and, eq, inArray } from "drizzle-orm";
import type { Database } from "../../db/client.js";
import { courses, segmentTranslations } from "../../db/schema.js";
import { courseLessonOrder } from "../translation/translateCourseLessons.js";
import { findMissingSegments } from "./findMissingSegments.js";
import { generateLocalizationForLesson, type GenerateLocalizationDeps } from "./generateLocalizationForLesson.js";

export interface CourseAudioOptions {
  /** Only these lessons (in course order). Default: every lesson. */
  lessonIds?: string[];
  /** Count what's missing (segments + characters) without calling ElevenLabs. */
  estimateOnly?: boolean;
  shouldStop?: () => boolean;
  onLesson?: (lesson: CourseAudioLessonResult, done: number, total: number) => void | Promise<void>;
}

export interface CourseAudioLessonResult {
  lessonId: string;
  /** Segments that had no clip before this run. */
  missing: number;
  /** Characters of those segments' text — what ElevenLabs bills. */
  characters: number;
  generated: number;
  errors: { segmentId: string; error: string }[];
  /** Why the lesson was left alone, if it was. */
  skipped?: string;
}

export interface CourseAudioResult {
  courseId: string;
  language: string;
  lessons: CourseAudioLessonResult[];
  stopped: boolean;
}

/**
 * Generates missing audio for every lesson of a course in one language by
 * calling generateLocalizationForLesson per lesson (fan-out, no duplicated
 * logic). Lessons that aren't parsed or not fully translated are skipped —
 * audio never triggers a DeepL call here. Resumable: re-running fills only
 * what's still missing.
 */
export async function generateCourseAudio(
  deps: GenerateLocalizationDeps,
  courseId: string,
  language: string,
  options: CourseAudioOptions = {}
): Promise<CourseAudioResult> {
  const { db } = deps;
  const [course] = await db.select({ id: courses.id }).from(courses).where(eq(courses.id, courseId)).limit(1);
  if (!course) throw new Error(`No course with id "${courseId}"`);

  let lessonIds = await courseLessonOrder(db, courseId);
  if (options.lessonIds?.length) {
    const unknown = options.lessonIds.filter((id) => !lessonIds.includes(id));
    if (unknown.length) throw new Error(`Not lessons of ${courseId}: ${unknown.join(", ")}`);
    lessonIds = lessonIds.filter((id) => options.lessonIds!.includes(id));
  }

  const result: CourseAudioResult = { courseId, language, lessons: [], stopped: false };
  for (const lessonId of lessonIds) {
    if (options.shouldStop?.()) {
      result.stopped = true;
      break;
    }
    const lesson = await generateLessonAudio(deps, lessonId, language, options);
    if (lesson.stopped) result.stopped = true;
    result.lessons.push(lesson.result);
    await options.onLesson?.(lesson.result, result.lessons.length, lessonIds.length);
    if (result.stopped) break;
  }
  return result;
}

async function generateLessonAudio(
  deps: GenerateLocalizationDeps,
  lessonId: string,
  language: string,
  options: CourseAudioOptions
): Promise<{ result: CourseAudioLessonResult; stopped: boolean }> {
  const base = { lessonId, missing: 0, characters: 0, generated: 0, errors: [] as CourseAudioLessonResult["errors"] };
  const { segments, missingSegments } = await findMissingSegments(deps.db, lessonId, language);
  if (!segments.length) return { result: { ...base, skipped: "not parsed" }, stopped: false };
  if (!missingSegments.length) return { result: { ...base, skipped: "audio complete" }, stopped: false };

  let texts = missingSegments.map((s) => s.text);
  if (language !== "en") {
    const rows = await deps.db
      .select({ segmentId: segmentTranslations.segmentId, text: segmentTranslations.translatedText })
      .from(segmentTranslations)
      .where(and(eq(segmentTranslations.targetLanguage, language), inArray(segmentTranslations.segmentId, segments.map((s) => s.id))));
    const byId = new Map(rows.map((r) => [r.segmentId, r.text]));
    const untranslated = segments.filter((s) => !byId.has(s.id)).length;
    if (untranslated) {
      return { result: { ...base, skipped: `${untranslated} of ${segments.length} segments not translated` }, stopped: false };
    }
    texts = missingSegments.map((s) => byId.get(s.id)!);
  }

  const counted = { ...base, missing: missingSegments.length, characters: texts.reduce((n, t) => n + t.length, 0) };
  if (options.estimateOnly) return { result: counted, stopped: false };

  const run = await generateLocalizationForLesson(deps, lessonId, language, { shouldStop: options.shouldStop });
  return { result: { ...counted, generated: run.succeeded.length, errors: run.errors }, stopped: run.stopped ?? false };
}
