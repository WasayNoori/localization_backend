// src/services/translation/translateScaffolding.ts
import { and, asc, eq, inArray } from "drizzle-orm";
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
import type { ITranslationReviewer, ReviewItem, ReviewVerdict } from "../../interfaces/ITranslationReviewer.js";
import { translateTexts, type TranslateTextsDeps } from "./translateTexts.js";

// "Scaffolding" = a course's name, section titles, lesson names and lesson
// descriptions — everything learners see around the lesson audio.

export interface TranslateScaffoldingDeps extends TranslateTextsDeps {
  translationReviewer: ITranslationReviewer;
}

/**
 * missing: only items never translated or whose English changed.
 * all: everything except hand corrections whose English is unchanged.
 */
export type ScaffoldingMode = "missing" | "all";

export class TranslateScaffoldingError extends Error {
  constructor(
    public readonly statusCode: 400 | 404,
    message: string
  ) {
    super(message);
  }
}

export interface ScaffoldingReviewSummary {
  /** Claude reviewed this run's translations. False when there was nothing to review or the reviewer failed. */
  ran: boolean;
  flagged: number;
  /** Reviewer failure — translations are still saved, just unreviewed. */
  error: string | null;
}

export interface TranslateCourseScaffoldingResult {
  courseId: string;
  targetLanguage: string;
  mode: ScaffoldingMode;
  translated: { course: number; sections: number; lessons: number };
  skipped: { course: number; sections: number; lessons: number };
  /** Hand corrections left as they are (counted in `skipped` too). */
  keptCorrections: number;
  review: ScaffoldingReviewSummary;
}

type LessonRow = typeof lessons.$inferSelect;
type ReviewFields = { reviewStatus: string | null; reviewNote: string | null; reviewedAt: Date | null };

/**
 * The scaffolding command for one course + language: DeepL translates (one
 * path, glossary + context — translateTexts), then Claude sanity-checks the
 * results and flags only clearly wrong items. DeepL's text is always what's
 * stored; a flag is advice for a human. Reviewer failure never loses the
 * translations. Sync on purpose — a few batched requests, not a fan-out.
 */
export async function translateCourseScaffolding(
  deps: TranslateScaffoldingDeps,
  courseId: string,
  targetLanguage: string,
  mode: ScaffoldingMode = "missing"
): Promise<TranslateCourseScaffoldingResult> {
  const { db } = deps;
  if (targetLanguage === "en") throw new TranslateScaffoldingError(400, `"en" is the source language — nothing to translate`);

  const [course] = await db.select().from(courses).where(eq(courses.id, courseId)).limit(1);
  if (!course) throw new TranslateScaffoldingError(404, `No course with id "${courseId}"`);

  const sections = await db
    .select()
    .from(courseSections)
    .where(eq(courseSections.courseId, courseId))
    .orderBy(asc(courseSections.sectionIndex));
  const lessonList = (
    await db
      .select({ lesson: lessons })
      .from(courseLessons)
      .innerJoin(lessons, eq(courseLessons.lessonId, lessons.id))
      .where(eq(courseLessons.courseId, courseId))
      .orderBy(asc(courseLessons.position))
  ).map((r) => r.lesson);

  const [existingCourse, existingSections, existingLessons] = await Promise.all([
    db.select().from(courseTranslations).where(eq(courseTranslations.courseId, courseId)),
    sections.length
      ? db.select().from(sectionTranslations).where(inArray(sectionTranslations.sectionId, sections.map((s) => s.id)))
      : Promise.resolve([]),
    lessonList.length
      ? db.select().from(lessonTranslations).where(inArray(lessonTranslations.lessonId, lessonList.map((l) => l.id)))
      : Promise.resolve([]),
  ]);
  const inLang = <T extends { targetLanguage: string }>(rows: T[]) => rows.filter((r) => r.targetLanguage === targetLanguage);

  // "current" = translated from today's English. A current hand correction is
  // kept even in mode "all"; a stale one is replaced like any stale row.
  const all = mode === "all";
  const courseRow = inLang(existingCourse).find((r) => r.sourceCourseName === course.courseName);
  const currentSections = new Map(
    inLang(existingSections)
      .filter((r) => sections.find((s) => s.id === r.sectionId)?.title === r.sourceTitle)
      .map((r) => [r.sectionId, r])
  );
  const currentLessons = new Map(
    inLang(existingLessons)
      .filter((r) => !lessonTitlesStale(r, lessonList.find((l) => l.id === r.lessonId)!))
      .map((r) => [r.lessonId, r])
  );
  const redo = (row: { editedAt: Date | null } | undefined) => !row || (all && !row.editedAt);
  const doCourse = redo(courseRow);
  const doSections = sections.filter((s) => redo(currentSections.get(s.id)));
  const doLessons = lessonList.filter((l) => redo(currentLessons.get(l.id)));
  const keptCorrections =
    (courseRow?.editedAt ? 1 : 0) +
    [...currentSections.values()].filter((r) => r.editedAt).length +
    [...currentLessons.values()].filter((r) => r.editedAt).length;

  const items: Omit<ReviewItem, "translation">[] = [];
  if (doCourse) items.push({ key: `course:${course.id}`, kind: "course", source: course.courseName });
  for (const s of doSections) items.push({ key: `section:${s.id}`, kind: "section", source: s.title });
  for (const l of doLessons) items.push(...lessonItems(l));

  const outline = courseOutline(course.courseName, sections, lessonList);
  const { translations, glossaryId, verdicts, review } = await translateAndReview(deps, items, targetLanguage, outline, outline);
  const now = new Date();

  await db.transaction(async (tx) => {
    if (doCourse) {
      const key = `course:${course.id}`;
      const values = {
        courseName: translations.get(key)!,
        sourceCourseName: course.courseName,
        deeplGlossaryId: glossaryId ?? null,
        ...reviewFields([key], verdicts, now),
        editedAt: null,
        updatedAt: now,
      };
      await tx
        .insert(courseTranslations)
        .values({ courseId, targetLanguage, ...values })
        .onConflictDoUpdate({ target: [courseTranslations.courseId, courseTranslations.targetLanguage], set: values });
    }
    for (const s of doSections) {
      const key = `section:${s.id}`;
      const values = {
        title: translations.get(key)!,
        sourceTitle: s.title,
        deeplGlossaryId: glossaryId ?? null,
        ...reviewFields([key], verdicts, now),
        editedAt: null,
        updatedAt: now,
      };
      await tx
        .insert(sectionTranslations)
        .values({ sectionId: s.id, targetLanguage, ...values })
        .onConflictDoUpdate({ target: [sectionTranslations.sectionId, sectionTranslations.targetLanguage], set: values });
    }
    for (const l of doLessons) {
      await upsertLessonTranslation(tx, l, targetLanguage, translations, verdicts, glossaryId, now);
    }
  });

  return {
    courseId,
    targetLanguage,
    mode,
    translated: { course: doCourse ? 1 : 0, sections: doSections.length, lessons: doLessons.length },
    skipped: {
      course: doCourse ? 0 : 1,
      sections: sections.length - doSections.length,
      lessons: lessonList.length - doLessons.length,
    },
    keptCorrections,
    review,
  };
}

/**
 * One lesson's name + description, through the same translate-and-review
 * pipeline. Used by lesson translation, which only fills a lesson's
 * scaffolding when it's missing or stale — it never re-translates current
 * (possibly reviewed) titles; that's the course scaffolding command's job.
 * Returns whether anything was translated.
 */
export async function translateLessonScaffoldingIfNeeded(
  deps: TranslateScaffoldingDeps,
  lesson: LessonRow,
  targetLanguage: string,
  /** DeepL context — the lesson script (capped), when the caller has it. */
  scriptContext?: string
): Promise<{ translated: boolean; review: ScaffoldingReviewSummary }> {
  const [existing] = await deps.db
    .select()
    .from(lessonTranslations)
    .where(and(eq(lessonTranslations.lessonId, lesson.id), eq(lessonTranslations.targetLanguage, targetLanguage)))
    .limit(1);
  if (existing && !lessonTitlesStale(existing, lesson)) {
    return { translated: false, review: { ran: false, flagged: 0, error: null } };
  }

  const outline = [`Lesson: ${lesson.lessonName}`, ...(lesson.description ? [`Description: ${lesson.description}`] : [])].join("\n");
  const { translations, glossaryId, verdicts, review } = await translateAndReview(
    deps,
    lessonItems(lesson),
    targetLanguage,
    outline,
    scriptContext
  );
  await upsertLessonTranslation(deps.db, lesson, targetLanguage, translations, verdicts, glossaryId, new Date());
  return { translated: true, review };
}

export function lessonTitlesStale(
  t: { sourceLessonName: string; sourceDescription: string | null },
  lesson: { lessonName: string; description: string | null }
): boolean {
  return t.sourceLessonName !== lesson.lessonName || (t.sourceDescription ?? null) !== (lesson.description ?? null);
}

// --- pipeline ---------------------------------------------------------------

/** `outline` is what Claude sees; `deeplContext` what DeepL gets (defaults to the outline). */
async function translateAndReview(
  deps: TranslateScaffoldingDeps,
  items: Omit<ReviewItem, "translation">[],
  targetLanguage: string,
  outline: string,
  deeplContext: string = outline
): Promise<{
  translations: Map<string, string>;
  glossaryId: string | undefined;
  verdicts: Map<string, ReviewVerdict>;
  review: ScaffoldingReviewSummary;
}> {
  const { translatedTexts, glossaryId } = await translateTexts(deps, {
    texts: items.map((i) => i.source),
    targetLanguage,
    context: deeplContext,
  });
  const translations = new Map(items.map((item, i) => [item.key, translatedTexts[i]]));

  const verdicts = new Map<string, ReviewVerdict>();
  const review: ScaffoldingReviewSummary = { ran: false, flagged: 0, error: null };
  if (items.length > 0) {
    try {
      const result = await deps.translationReviewer.review({
        targetLanguage,
        context: outline,
        items: items.map((item) => ({ ...item, translation: translations.get(item.key)! })),
      });
      for (const v of result) verdicts.set(v.key, v);
      review.ran = true;
      review.flagged = result.filter((v) => v.flagged).length;
    } catch (err) {
      review.error = err instanceof Error ? err.message : String(err);
    }
  }
  return { translations, glossaryId, verdicts, review };
}

function lessonItems(l: LessonRow): Omit<ReviewItem, "translation">[] {
  return [
    { key: `lessonName:${l.id}`, kind: "lessonName", source: l.lessonName },
    ...(l.description ? [{ key: `lessonDescription:${l.id}`, kind: "lessonDescription" as const, source: l.description }] : []),
  ];
}

function courseOutline(courseName: string, sections: { sectionIndex: number; title: string }[], lessonList: LessonRow[]): string {
  return [
    `Course: ${courseName}`,
    ...sections.map((s) => `Section ${s.sectionIndex}: ${s.title}`),
    ...lessonList.map((l) => `Lesson: ${l.lessonName}`),
  ].join("\n");
}

/**
 * Review state for a stored row from its items' verdicts: 'flagged' if any
 * item was flagged (reasons joined), 'ok' if all were reviewed and passed,
 * null if any item went unreviewed.
 */
function reviewFields(keys: string[], verdicts: Map<string, ReviewVerdict>, now: Date): ReviewFields {
  const found = keys.map((k) => verdicts.get(k));
  const flagged = found.filter((v): v is ReviewVerdict => !!v?.flagged);
  if (flagged.length) {
    const label = (key: string) => (key.startsWith("lessonDescription") ? "Description" : "Name");
    const note = flagged.map((v) => (keys.length > 1 ? `${label(v.key)}: ${v.reason}` : v.reason)).join(" ");
    return { reviewStatus: "flagged", reviewNote: note, reviewedAt: now };
  }
  if (found.every((v) => v)) return { reviewStatus: "ok", reviewNote: null, reviewedAt: now };
  return { reviewStatus: null, reviewNote: null, reviewedAt: null };
}

async function upsertLessonTranslation(
  db: Pick<Database, "insert">,
  lesson: LessonRow,
  targetLanguage: string,
  translations: Map<string, string>,
  verdicts: Map<string, ReviewVerdict>,
  glossaryId: string | undefined,
  now: Date
) {
  const keys = lessonItems(lesson).map((i) => i.key);
  const values = {
    lessonName: translations.get(`lessonName:${lesson.id}`)!,
    description: lesson.description ? translations.get(`lessonDescription:${lesson.id}`)! : null,
    sourceLessonName: lesson.lessonName,
    sourceDescription: lesson.description,
    deeplGlossaryId: glossaryId ?? null,
    ...reviewFields(keys, verdicts, now),
    editedAt: null,
    updatedAt: now,
  };
  await db
    .insert(lessonTranslations)
    .values({ lessonId: lesson.id, targetLanguage, ...values })
    .onConflictDoUpdate({ target: [lessonTranslations.lessonId, lessonTranslations.targetLanguage], set: values });
}
