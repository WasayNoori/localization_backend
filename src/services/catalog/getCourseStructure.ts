// src/services/catalog/getCourseStructure.ts
import { asc, eq, inArray } from "drizzle-orm";
import type { Database } from "../../db/client.js";
import {
  courses,
  courseSections,
  courseLessons,
  courseTranslations,
  lessons,
  lessonTranslations,
  sectionTranslations,
} from "../../db/schema.js";
import { lessonTitlesStale } from "../translation/translateCatalogTitles.js";
import { getLocalizationCoverage, sumCoverage, type LanguageCoverage } from "./getLocalizationCoverage.js";

export interface CourseStructureLesson {
  id: string;
  lessonName: string;
  description: string | null;
  position: number | null;
  hasScript: boolean;
  boxFileId: string | null;
  parsedAt: Date | null;
  segmentCount: number;
  /** Script changed after the last parse — segments were cut from an older script. */
  parseStale: boolean;
  /** Per-language counts; languages with no work yet are absent (treat as zero). */
  localization: LanguageCoverage[];
  tags: string[];
  /** Translated name/description per language; `stale` = English changed since. */
  translations: { language: string; lessonName: string; description: string | null; stale: boolean }[];
}

export interface CourseStructureSection {
  id: string;
  sectionIndex: number;
  title: string;
  translations: { language: string; title: string; stale: boolean }[];
  lessons: CourseStructureLesson[];
}

export interface CourseStructure {
  id: string;
  courseName: string;
  status: string | null;
  updatedAt: Date;
  segmentCount: number;
  coverage: (LanguageCoverage & { lessonsComplete: number })[];
  translations: { language: string; courseName: string; stale: boolean }[];
  sections: CourseStructureSection[];
  /** Members not placed in any section (e.g. rows from before sections existed). */
  unsectionedLessons: CourseStructureLesson[];
}

/** Read-only: course → ordered sections → ordered lessons, with parse state. Null if the course doesn't exist. */
export async function getCourseStructure(db: Database, courseId: string): Promise<CourseStructure | null> {
  const [course] = await db.select().from(courses).where(eq(courses.id, courseId)).limit(1);
  if (!course) return null;

  const sectionRows = await db
    .select()
    .from(courseSections)
    .where(eq(courseSections.courseId, courseId))
    .orderBy(asc(courseSections.sectionIndex));

  const memberRows = await db
    .select({
      sectionId: courseLessons.sectionId,
      position: courseLessons.position,
      lesson: lessons,
    })
    .from(courseLessons)
    .innerJoin(lessons, eq(courseLessons.lessonId, lessons.id))
    .where(eq(courseLessons.courseId, courseId))
    .orderBy(asc(courseLessons.position), asc(lessons.id));

  const lessonIds = memberRows.map((m) => m.lesson.id);
  const coverage = await getLocalizationCoverage(db, lessonIds);
  const sectionIds = sectionRows.map((s) => s.id);
  const [courseTr, sectionTr, lessonTr] = await Promise.all([
    db.select().from(courseTranslations).where(eq(courseTranslations.courseId, courseId)),
    sectionIds.length
      ? db.select().from(sectionTranslations).where(inArray(sectionTranslations.sectionId, sectionIds))
      : Promise.resolve([]),
    lessonIds.length
      ? db.select().from(lessonTranslations).where(inArray(lessonTranslations.lessonId, lessonIds))
      : Promise.resolve([]),
  ]);
  const byLanguage = <T extends { targetLanguage: string }>(a: T, b: T) => a.targetLanguage.localeCompare(b.targetLanguage);

  const toLesson = (m: (typeof memberRows)[number]): CourseStructureLesson => {
    const l = m.lesson;
    return {
      id: l.id,
      lessonName: l.lessonName,
      description: l.description,
      position: m.position,
      hasScript: l.scriptText !== null,
      boxFileId: l.boxFileId,
      parsedAt: l.parsedAt,
      segmentCount: coverage.get(l.id)!.segmentCount,
      parseStale: !!(l.parsedAt && l.scriptUpdatedAt && l.scriptUpdatedAt > l.parsedAt),
      localization: coverage.get(l.id)!.languages,
      tags: l.tags,
      translations: lessonTr
        .filter((t) => t.lessonId === l.id)
        .sort(byLanguage)
        .map((t) => ({
          language: t.targetLanguage,
          lessonName: t.lessonName,
          description: t.description,
          stale: lessonTitlesStale(t, l),
        })),
    };
  };

  const totals = sumCoverage(lessonIds.map((id) => coverage.get(id)!));

  return {
    id: course.id,
    courseName: course.courseName,
    status: course.status,
    updatedAt: course.updatedAt,
    segmentCount: totals.segmentCount,
    coverage: totals.languages,
    translations: courseTr
      .sort(byLanguage)
      .map((t) => ({ language: t.targetLanguage, courseName: t.courseName, stale: t.sourceCourseName !== course.courseName })),
    sections: sectionRows.map((s) => ({
      id: s.id,
      sectionIndex: s.sectionIndex,
      title: s.title,
      translations: sectionTr
        .filter((t) => t.sectionId === s.id)
        .sort(byLanguage)
        .map((t) => ({ language: t.targetLanguage, title: t.title, stale: t.sourceTitle !== s.title })),
      lessons: memberRows.filter((m) => m.sectionId === s.id).map(toLesson),
    })),
    unsectionedLessons: memberRows.filter((m) => m.sectionId === null).map(toLesson),
  };
}
