// src/services/catalog/updateCourseScripts.ts
import { and, eq, inArray } from "drizzle-orm";
import type { Database } from "../../db/client.js";
import { courses, courseLessons, lessons } from "../../db/schema.js";

export interface CourseScriptInput {
  lessonId: string;
  scriptText: string;
}

export interface UpdateCourseScriptsResult {
  courseId: string;
  /** True when nothing was saved (preview). */
  dryRun: boolean;
  /** Script set or changed. */
  scriptsChanged: string[];
  /** Same text as already stored — nothing written. */
  unchanged: string[];
  /** Subset of scriptsChanged that were already parsed — their segments are now stale. */
  needsReparse: string[];
}

export class CourseScriptsError extends Error {
  constructor(
    public readonly statusCode: 400 | 404,
    message: string
  ) {
    super(message);
  }
}

class DryRunRollback extends Error {
  constructor(public readonly result: UpdateCourseScriptsResult) {
    super("dry run");
  }
}

/**
 * Scripts-only upload for lessons already in a course. Touches nothing but
 * lessons.script_text / script_updated_at — structure and membership are
 * left alone, so a partial list is safe (unlike POST /courses/import, whose
 * payload is the full structure). All-or-nothing: an unknown lesson or one
 * not in this course rejects the whole request. Never parses.
 */
export async function updateCourseScripts(
  db: Database,
  courseId: string,
  scripts: CourseScriptInput[],
  options: { dryRun?: boolean } = {}
): Promise<UpdateCourseScriptsResult> {
  const ids = scripts.map((s) => s.lessonId);
  const duplicate = ids.find((id, i) => ids.indexOf(id) !== i);
  if (duplicate) {
    throw new CourseScriptsError(400, `Lesson "${duplicate}" appears more than once`);
  }

  const [course] = await db.select({ id: courses.id }).from(courses).where(eq(courses.id, courseId)).limit(1);
  if (!course) {
    throw new CourseScriptsError(404, `No course with id "${courseId}"`);
  }

  try {
    return await db.transaction(async (tx) => {
      const members = ids.length
        ? await tx
            .select({ lesson: lessons })
            .from(courseLessons)
            .innerJoin(lessons, eq(courseLessons.lessonId, lessons.id))
            .where(and(eq(courseLessons.courseId, courseId), inArray(courseLessons.lessonId, ids)))
        : [];
      const byId = new Map(members.map((m) => [m.lesson.id, m.lesson]));
      const missing = ids.filter((id) => !byId.has(id));
      if (missing.length) {
        throw new CourseScriptsError(400, `Not lessons of course "${courseId}": ${missing.join(", ")}`);
      }

      const now = new Date();
      const result: UpdateCourseScriptsResult = {
        courseId,
        dryRun: !!options.dryRun,
        scriptsChanged: [],
        unchanged: [],
        needsReparse: [],
      };

      for (const { lessonId, scriptText } of scripts) {
        const existing = byId.get(lessonId)!;
        if (existing.scriptText === scriptText) {
          result.unchanged.push(lessonId);
          continue;
        }
        await tx
          .update(lessons)
          .set({ scriptText, scriptUpdatedAt: now, updatedAt: now })
          .where(eq(lessons.id, lessonId));
        result.scriptsChanged.push(lessonId);
        if (existing.parsedAt) result.needsReparse.push(lessonId);
      }

      if (options.dryRun) throw new DryRunRollback(result);
      return result;
    });
  } catch (err) {
    if (err instanceof DryRunRollback) return err.result;
    throw err;
  }
}
