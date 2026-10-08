// src/modules/quiz/DbQuizCourseContext.ts
import { eq } from "drizzle-orm";
import type { Database } from "../../db/client.js";
import { courseLessons, courses, lessons } from "../../db/schema.js";
import type { IQuizCourseContext } from "./interfaces.js";
import type { QuizCourse } from "./quizTypes.js";

/** Reads the course's name, Box folder, Monday board and lessons. Read-only — the module stores nothing here. */
export class DbQuizCourseContext implements IQuizCourseContext {
  constructor(private readonly db: Database) {}

  async getCourse(courseId: string): Promise<QuizCourse | null> {
    const [course] = await this.db.select().from(courses).where(eq(courses.id, courseId)).limit(1);
    if (!course) return null;
    const rows = await this.db
      .select({ id: lessons.id, name: lessons.lessonName })
      .from(courseLessons)
      .innerJoin(lessons, eq(lessons.id, courseLessons.lessonId))
      .where(eq(courseLessons.courseId, courseId));
    return {
      id: course.id,
      courseName: course.courseName,
      boxFolderId: course.boxFolderId,
      mondayBoardId: course.mondayBoardId,
      lessons: rows,
    };
  }
}
