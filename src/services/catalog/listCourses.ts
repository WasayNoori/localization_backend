// src/services/catalog/listCourses.ts
import { asc, count } from "drizzle-orm";
import type { Database } from "../../db/client.js";
import { courses, courseLessons, courseSections } from "../../db/schema.js";
import { getLocalizationCoverage, sumCoverage, type LanguageCoverage } from "./getLocalizationCoverage.js";

export interface CourseListItem {
  id: string;
  courseName: string;
  status: string | null;
  sectionCount: number;
  lessonCount: number;
  segmentCount: number;
  coverage: (LanguageCoverage & { lessonsComplete: number })[];
  updatedAt: Date;
}

/** Read-only: every course with structure counts and per-language coverage. */
export async function listCourses(db: Database): Promise<CourseListItem[]> {
  const [courseRows, sectionCounts, memberRows] = await Promise.all([
    db.select().from(courses).orderBy(asc(courses.courseName)),
    db
      .select({ courseId: courseSections.courseId, n: count() })
      .from(courseSections)
      .groupBy(courseSections.courseId),
    db.select({ courseId: courseLessons.courseId, lessonId: courseLessons.lessonId }).from(courseLessons),
  ]);

  const sectionsByCourse = new Map(sectionCounts.map((r) => [r.courseId, Number(r.n)]));
  const lessonsByCourse = new Map<string, string[]>();
  for (const m of memberRows) {
    lessonsByCourse.set(m.courseId, [...(lessonsByCourse.get(m.courseId) ?? []), m.lessonId]);
  }

  const allLessonIds = [...new Set(memberRows.map((m) => m.lessonId))];
  const coverage = await getLocalizationCoverage(db, allLessonIds);

  return courseRows.map((c) => {
    const lessonIds = lessonsByCourse.get(c.id) ?? [];
    const totals = sumCoverage(lessonIds.map((id) => coverage.get(id)!));
    return {
      id: c.id,
      courseName: c.courseName,
      status: c.status,
      sectionCount: sectionsByCourse.get(c.id) ?? 0,
      lessonCount: lessonIds.length,
      segmentCount: totals.segmentCount,
      coverage: totals.languages,
      updatedAt: c.updatedAt,
    };
  });
}

