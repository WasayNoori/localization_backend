// src/services/catalog/courseBoxFolderForLesson.ts
import { eq } from "drizzle-orm";
import type { Database } from "../../db/client.js";
import { courseLessons, courses } from "../../db/schema.js";

export class LessonCourseError extends Error {}

/**
 * The Box folder a lesson's audio goes to: its course's top-level folder. A
 * lesson can belong to several courses, so `courseId` picks one when it does;
 * with a single course it's optional.
 */
export async function courseBoxFolderForLesson(
  db: Database,
  lessonId: string,
  courseId?: string
): Promise<{ courseId: string; boxFolderId: string }> {
  const rows = await db
    .select({ courseId: courses.id, boxFolderId: courses.boxFolderId })
    .from(courseLessons)
    .innerJoin(courses, eq(courses.id, courseLessons.courseId))
    .where(eq(courseLessons.lessonId, lessonId));
  const candidates = courseId ? rows.filter((r) => r.courseId === courseId) : rows;

  if (!rows.length) throw new LessonCourseError(`Lesson "${lessonId}" isn't in any course`);
  if (courseId && !candidates.length) throw new LessonCourseError(`Lesson "${lessonId}" isn't in course "${courseId}"`);
  if (candidates.length > 1) {
    throw new LessonCourseError(`Lesson "${lessonId}" is in several courses (${rows.map((r) => r.courseId).join(", ")}) — pass courseId`);
  }
  const [course] = candidates;
  if (!course.boxFolderId) throw new LessonCourseError(`Course "${course.courseId}" has no Box folder — set it on the course page`);
  return { courseId: course.courseId, boxFolderId: course.boxFolderId };
}
