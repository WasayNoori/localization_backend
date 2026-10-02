// src/services/catalog/getCourseStructure.ts
import { asc, count, eq, inArray } from "drizzle-orm";
import type { Database } from "../../db/client.js";
import { courses, courseSections, courseLessons, lessons, lessonSegments } from "../../db/schema.js";

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
}

export interface CourseStructureSection {
  id: string;
  sectionIndex: number;
  title: string;
  lessons: CourseStructureLesson[];
}

export interface CourseStructure {
  id: string;
  courseName: string;
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
  const counts = lessonIds.length
    ? await db
        .select({ lessonId: lessonSegments.lessonId, n: count() })
        .from(lessonSegments)
        .where(inArray(lessonSegments.lessonId, lessonIds))
        .groupBy(lessonSegments.lessonId)
    : [];
  const segmentCountById = new Map(counts.map((c) => [c.lessonId, Number(c.n)]));

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
      segmentCount: segmentCountById.get(l.id) ?? 0,
      parseStale: !!(l.parsedAt && l.scriptUpdatedAt && l.scriptUpdatedAt > l.parsedAt),
    };
  };

  return {
    id: course.id,
    courseName: course.courseName,
    sections: sectionRows.map((s) => ({
      id: s.id,
      sectionIndex: s.sectionIndex,
      title: s.title,
      lessons: memberRows.filter((m) => m.sectionId === s.id).map(toLesson),
    })),
    unsectionedLessons: memberRows.filter((m) => m.sectionId === null).map(toLesson),
  };
}
