// src/services/catalog/updateCourseScripts.ts
import { and, eq, inArray } from "drizzle-orm";
import { courses, courseLessons, lessons } from "../../db/schema.js";
export class CourseScriptsError extends Error {
    statusCode;
    constructor(statusCode, message) {
        super(message);
        this.statusCode = statusCode;
    }
}
class DryRunRollback extends Error {
    result;
    constructor(result) {
        super("dry run");
        this.result = result;
    }
}
/**
 * Scripts-only upload for lessons already in a course. Touches nothing but
 * lessons.script_text / script_updated_at — structure and membership are
 * left alone, so a partial list is safe (unlike POST /courses/import, whose
 * payload is the full structure). All-or-nothing: an unknown lesson or one
 * not in this course rejects the whole request. Never parses.
 */
export async function updateCourseScripts(db, courseId, scripts, options = {}) {
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
            const result = {
                courseId,
                dryRun: !!options.dryRun,
                scriptsChanged: [],
                unchanged: [],
                needsReparse: [],
            };
            for (const { lessonId, scriptText, sourceText } of scripts) {
                const existing = byId.get(lessonId);
                const scriptSourceText = sourceText ?? null;
                // A plain upload of the file a stored script was typo-fixed from is the same script.
                const sameAsProofreadSource = sourceText === undefined && existing.scriptSourceText === scriptText;
                if (existing.scriptText === scriptText || sameAsProofreadSource) {
                    // Same script — only record its source if that changed (no parse impact).
                    if (sourceText !== undefined && existing.scriptSourceText !== scriptSourceText) {
                        await tx.update(lessons).set({ scriptSourceText }).where(eq(lessons.id, lessonId));
                    }
                    result.unchanged.push(lessonId);
                    continue;
                }
                await tx
                    .update(lessons)
                    // New text from a plain upload hasn't been typo-checked: clear the marker so Translate checks it.
                    .set({ scriptText, scriptSourceText, scriptUpdatedAt: now, updatedAt: now })
                    .where(eq(lessons.id, lessonId));
                result.scriptsChanged.push(lessonId);
                if (existing.parsedAt)
                    result.needsReparse.push(lessonId);
            }
            if (options.dryRun)
                throw new DryRunRollback(result);
            return result;
        });
    }
    catch (err) {
        if (err instanceof DryRunRollback)
            return err.result;
        throw err;
    }
}
//# sourceMappingURL=updateCourseScripts.js.map