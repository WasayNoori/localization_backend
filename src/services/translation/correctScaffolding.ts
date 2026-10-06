// src/services/translation/correctScaffolding.ts
import { and, eq, inArray } from "drizzle-orm";
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
import { TranslateScaffoldingError } from "./translateScaffolding.js";

/** Hand corrections to one course's scaffolding in one language. Every field is optional. */
export interface ScaffoldingCorrections {
  courseName?: string;
  sections?: { sectionId: string; title: string }[];
  /** Omit a field to keep it. A lesson with no translation yet needs lessonName (and description if the English has one). */
  lessons?: { lessonId: string; lessonName?: string; description?: string }[];
}

export interface CorrectScaffoldingResult {
  courseId: string;
  targetLanguage: string;
  corrected: { course: number; sections: number; lessons: number };
}

/**
 * Stores a person's corrected translation as-is: snapshots today's English
 * (so it's current), clears Claude's review (a human decided) and stamps
 * edited_at so "Re-translate all" keeps it. No DeepL or Claude call.
 * All-or-nothing: validates everything, then writes in one transaction.
 */
export async function correctScaffolding(
  db: Database,
  courseId: string,
  targetLanguage: string,
  corrections: ScaffoldingCorrections
): Promise<CorrectScaffoldingResult> {
  const bad = (message: string) => new TranslateScaffoldingError(400, message);
  if (targetLanguage === "en") throw bad(`"en" is the source language — edit the English through the import instead`);

  const [course] = await db.select().from(courses).where(eq(courses.id, courseId)).limit(1);
  if (!course) throw new TranslateScaffoldingError(404, `No course with id "${courseId}"`);

  const text = (value: string | undefined, what: string) => {
    if (value === undefined) return undefined;
    const trimmed = value.trim();
    if (!trimmed) throw bad(`${what} can't be empty`);
    return trimmed;
  };
  const courseName = text(corrections.courseName, "Course name");
  const sectionInput = (corrections.sections ?? []).map((s) => ({ sectionId: s.sectionId, title: text(s.title, "Section title")! }));
  const lessonInput = (corrections.lessons ?? []).map((l) => ({
    lessonId: l.lessonId,
    lessonName: text(l.lessonName, `Name of ${l.lessonId}`),
    description: text(l.description, `Description of ${l.lessonId}`),
  }));
  if (courseName === undefined && !sectionInput.length && !lessonInput.length) throw bad("Nothing to correct");

  const sectionRows = sectionInput.length
    ? await db
        .select()
        .from(courseSections)
        .where(and(eq(courseSections.courseId, courseId), inArray(courseSections.id, sectionInput.map((s) => s.sectionId))))
    : [];
  for (const s of sectionInput) {
    if (!sectionRows.some((r) => r.id === s.sectionId)) throw bad(`Section ${s.sectionId} is not in course ${courseId}`);
  }

  const lessonRows = lessonInput.length
    ? (
        await db
          .select({ lesson: lessons })
          .from(courseLessons)
          .innerJoin(lessons, eq(courseLessons.lessonId, lessons.id))
          .where(and(eq(courseLessons.courseId, courseId), inArray(lessons.id, lessonInput.map((l) => l.lessonId))))
      ).map((r) => r.lesson)
    : [];
  const existingLessonTr = lessonRows.length
    ? await db
        .select()
        .from(lessonTranslations)
        .where(
          and(eq(lessonTranslations.targetLanguage, targetLanguage), inArray(lessonTranslations.lessonId, lessonRows.map((l) => l.id)))
        )
    : [];

  const now = new Date();
  const corrected = { reviewStatus: null, reviewNote: null, reviewedAt: null, deeplGlossaryId: null, editedAt: now, updatedAt: now };

  // Resolve every lesson row before writing anything.
  const lessonValues = lessonInput.map((input) => {
    const lesson = lessonRows.find((l) => l.id === input.lessonId);
    if (!lesson) throw bad(`Lesson ${input.lessonId} is not in course ${courseId}`);
    if (input.description !== undefined && !lesson.description) {
      throw bad(`Lesson ${input.lessonId} has no English description to translate`);
    }
    const existing = existingLessonTr.find((t) => t.lessonId === lesson.id);
    const lessonName = input.lessonName ?? existing?.lessonName;
    const description = lesson.description ? (input.description ?? existing?.description ?? null) : null;
    if (!lessonName) throw bad(`Lesson ${input.lessonId} has no translation yet — give lessonName`);
    if (lesson.description && !description) throw bad(`Lesson ${input.lessonId} has no translated description yet — give description`);
    return {
      lessonId: lesson.id,
      values: { lessonName, description, sourceLessonName: lesson.lessonName, sourceDescription: lesson.description, ...corrected },
    };
  });

  await db.transaction(async (tx) => {
    if (courseName !== undefined) {
      const values = { courseName, sourceCourseName: course.courseName, ...corrected };
      await tx
        .insert(courseTranslations)
        .values({ courseId, targetLanguage, ...values })
        .onConflictDoUpdate({ target: [courseTranslations.courseId, courseTranslations.targetLanguage], set: values });
    }
    for (const s of sectionInput) {
      const values = { title: s.title, sourceTitle: sectionRows.find((r) => r.id === s.sectionId)!.title, ...corrected };
      await tx
        .insert(sectionTranslations)
        .values({ sectionId: s.sectionId, targetLanguage, ...values })
        .onConflictDoUpdate({ target: [sectionTranslations.sectionId, sectionTranslations.targetLanguage], set: values });
    }
    for (const { lessonId, values } of lessonValues) {
      await tx
        .insert(lessonTranslations)
        .values({ lessonId, targetLanguage, ...values })
        .onConflictDoUpdate({ target: [lessonTranslations.lessonId, lessonTranslations.targetLanguage], set: values });
    }
  });

  return {
    courseId,
    targetLanguage,
    corrected: { course: courseName !== undefined ? 1 : 0, sections: sectionInput.length, lessons: lessonValues.length },
  };
}
