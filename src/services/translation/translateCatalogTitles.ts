// src/services/translation/translateCatalogTitles.ts
import { asc, eq, inArray } from "drizzle-orm";
import type { Database } from "../../db/client.js";
import {
  courses,
  courseLessons,
  courseSections,
  courseTranslations,
  lessons,
  lessonTranslations,
  sectionTranslations,
} from "../../db/schema.js";
import type { ITranslationService } from "../../interfaces/ITranslationService.js";
import { getGlossaryId } from "./getGlossaryId.js";

export interface TranslateTitlesDeps {
  db: Database;
  translationService: ITranslationService;
}

export class TranslateTitlesError extends Error {
  constructor(
    public readonly statusCode: 400 | 404,
    message: string
  ) {
    super(message);
  }
}

export interface TranslateCourseTitlesResult {
  courseId: string;
  targetLanguage: string;
  /** How many items were sent to DeepL (missing or stale, or all with force). */
  translated: { course: number; sections: number; lessons: number };
  /** Already current — skipped. */
  skipped: { course: number; sections: number; lessons: number };
}

type LessonRow = typeof lessons.$inferSelect;

/**
 * Course name, section titles and every lesson's name + description for one
 * language. Short texts, so they go to DeepL in batches (≤50 per request),
 * all with the course's English titles as context so terms stay consistent.
 * Only missing or stale items are sent unless `force`. Sync on purpose — a
 * handful of DeepL requests, not a per-lesson fan-out (docs/decisions.md).
 */
export async function translateCourseTitles(
  deps: TranslateTitlesDeps,
  courseId: string,
  targetLanguage: string,
  options: { force?: boolean } = {}
): Promise<TranslateCourseTitlesResult> {
  const { db } = deps;
  if (targetLanguage === "en") throw new TranslateTitlesError(400, `"en" is the source language — nothing to translate`);

  const [course] = await db.select().from(courses).where(eq(courses.id, courseId)).limit(1);
  if (!course) throw new TranslateTitlesError(404, `No course with id "${courseId}"`);

  const sections = await db
    .select()
    .from(courseSections)
    .where(eq(courseSections.courseId, courseId))
    .orderBy(asc(courseSections.sectionIndex));
  const lessonRows = await db
    .select({ lesson: lessons })
    .from(courseLessons)
    .innerJoin(lessons, eq(courseLessons.lessonId, lessons.id))
    .where(eq(courseLessons.courseId, courseId));
  const courseLessonsList = lessonRows.map((r) => r.lesson);

  const [existingCourse, existingSections, existingLessons] = await Promise.all([
    db.select().from(courseTranslations).where(eq(courseTranslations.courseId, courseId)),
    sections.length
      ? db.select().from(sectionTranslations).where(inArray(sectionTranslations.sectionId, sections.map((s) => s.id)))
      : Promise.resolve([]),
    courseLessonsList.length
      ? db.select().from(lessonTranslations).where(inArray(lessonTranslations.lessonId, courseLessonsList.map((l) => l.id)))
      : Promise.resolve([]),
  ]);

  const lang = (r: { targetLanguage: string }) => r.targetLanguage === targetLanguage;
  const courseCurrent = existingCourse.find((r) => lang(r) && r.sourceCourseName === course.courseName);
  const sectionCurrent = new Set(
    existingSections.filter((r) => lang(r) && sections.find((s) => s.id === r.sectionId)?.title === r.sourceTitle).map((r) => r.sectionId)
  );
  const lessonCurrent = new Set(
    existingLessons
      .filter((r) => lang(r) && !lessonTitlesStale(r, courseLessonsList.find((l) => l.id === r.lessonId)!))
      .map((r) => r.lessonId)
  );

  const doCourse = options.force || !courseCurrent;
  const doSections = sections.filter((s) => options.force || !sectionCurrent.has(s.id));
  const doLessons = courseLessonsList.filter((l) => options.force || !lessonCurrent.has(l.id));

  const texts: string[] = [];
  if (doCourse) texts.push(course.courseName);
  for (const s of doSections) texts.push(s.title);
  for (const l of doLessons) {
    texts.push(l.lessonName);
    if (l.description) texts.push(l.description);
  }

  const glossaryId = await getGlossaryId(db, targetLanguage);
  const context = [
    `Course: ${course.courseName}`,
    ...sections.map((s) => `Section ${s.sectionIndex}: ${s.title}`),
    ...courseLessonsList.map((l) => `Lesson: ${l.lessonName}`),
  ].join("\n");

  const { translatedTexts } = texts.length
    ? await deps.translationService.translateMany({ texts, targetLanguage, glossaryId, context })
    : { translatedTexts: [] as string[] };

  let i = 0;
  const next = () => translatedTexts[i++];
  const now = new Date();

  await db.transaction(async (tx) => {
    if (doCourse) {
      const values = { courseName: next(), sourceCourseName: course.courseName, deeplGlossaryId: glossaryId ?? null, updatedAt: now };
      await tx
        .insert(courseTranslations)
        .values({ courseId, targetLanguage, ...values })
        .onConflictDoUpdate({ target: [courseTranslations.courseId, courseTranslations.targetLanguage], set: values });
    }
    for (const s of doSections) {
      const values = { title: next(), sourceTitle: s.title, deeplGlossaryId: glossaryId ?? null, updatedAt: now };
      await tx
        .insert(sectionTranslations)
        .values({ sectionId: s.id, targetLanguage, ...values })
        .onConflictDoUpdate({ target: [sectionTranslations.sectionId, sectionTranslations.targetLanguage], set: values });
    }
    for (const l of doLessons) {
      const lessonName = next();
      const description = l.description ? next() : null;
      await upsertLessonTranslation(tx, l, targetLanguage, { lessonName, description }, glossaryId, now);
    }
  });

  return {
    courseId,
    targetLanguage,
    translated: { course: doCourse ? 1 : 0, sections: doSections.length, lessons: doLessons.length },
    skipped: {
      course: doCourse ? 0 : 1,
      sections: sections.length - doSections.length,
      lessons: courseLessonsList.length - doLessons.length,
    },
  };
}

/**
 * One lesson's name + description (one DeepL request). Used by the lesson
 * translate endpoint so "translate this lesson" covers its titles too.
 * `context` is the lesson's script, when available.
 */
export async function translateLessonTitles(
  deps: TranslateTitlesDeps,
  lesson: LessonRow,
  targetLanguage: string,
  context?: string
): Promise<void> {
  const glossaryId = await getGlossaryId(deps.db, targetLanguage);
  const texts = lesson.description ? [lesson.lessonName, lesson.description] : [lesson.lessonName];
  const { translatedTexts } = await deps.translationService.translateMany({ texts, targetLanguage, glossaryId, context });
  await upsertLessonTranslation(
    deps.db,
    lesson,
    targetLanguage,
    { lessonName: translatedTexts[0], description: lesson.description ? translatedTexts[1] : null },
    glossaryId,
    new Date()
  );
}

export function lessonTitlesStale(
  t: { sourceLessonName: string; sourceDescription: string | null },
  lesson: { lessonName: string; description: string | null }
): boolean {
  return t.sourceLessonName !== lesson.lessonName || (t.sourceDescription ?? null) !== (lesson.description ?? null);
}

async function upsertLessonTranslation(
  db: Pick<Database, "insert">,
  lesson: LessonRow,
  targetLanguage: string,
  translated: { lessonName: string; description: string | null },
  glossaryId: string | undefined,
  now: Date
) {
  const values = {
    lessonName: translated.lessonName,
    description: translated.description,
    sourceLessonName: lesson.lessonName,
    sourceDescription: lesson.description,
    deeplGlossaryId: glossaryId ?? null,
    updatedAt: now,
  };
  await db
    .insert(lessonTranslations)
    .values({ lessonId: lesson.id, targetLanguage, ...values })
    .onConflictDoUpdate({ target: [lessonTranslations.lessonId, lessonTranslations.targetLanguage], set: values });
}

