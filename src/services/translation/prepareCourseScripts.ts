// src/services/translation/prepareCourseScripts.ts
import { and, eq, inArray, ne } from "drizzle-orm";
import type { Database } from "../../db/client.js";
import { lessons, lessonSegments, segmentTranslations, ttsClips } from "../../db/schema.js";
import type { INlpService } from "../../interfaces/INlpService.js";
import type { IScriptProofreader } from "../../interfaces/IScriptProofreader.js";
import { parseLessonSegments } from "../parsing/parseLessonSegments.js";
import { applyScriptCorrections } from "../proofreading/applyScriptCorrections.js";
import { courseLessonOrder } from "./translateCourseLessons.js";

export interface PrepareScriptsDeps {
  db: Database;
  nlpService: INlpService;
  /** Required when `proofread` is on. */
  scriptProofreader?: IScriptProofreader;
}

/** A proposed fix that wasn't applied automatically — a person decides. */
export interface ScriptReviewItem {
  lessonId: string;
  original: string;
  corrected: string;
  reason: string;
  why: string;
}

export interface PrepareScriptsResult {
  /** Lessons proofread in this run. */
  proofread: number;
  /** Mechanical fixes applied to scripts. */
  fixesApplied: number;
  /** Lessons (re-)cut into segments in this run. */
  parsed: number;
  review: ScriptReviewItem[];
  /** Per-lesson problems (proofreading or parsing failed, or fixes held back). */
  issues: { lessonId: string; issue: string }[];
}

/**
 * Gets a course's scripts ready to translate, once for all languages:
 *  1. proofread (optional) — every script not proofread yet; mechanical fixes
 *     are applied, the rest is returned for review. A lesson that already has
 *     translations or audio in any language is never changed (changing its
 *     script means re-cutting its segments, which deletes them) — its fixes
 *     are reported instead.
 *  2. parse — every lesson with a script and no segments, or whose script
 *     changed and that has nothing to lose yet.
 * Idempotent: a second run finds nothing left to do.
 */
export async function prepareCourseScripts(
  deps: PrepareScriptsDeps,
  courseId: string,
  options: { proofread: boolean; onLesson?: () => void | Promise<void> }
): Promise<PrepareScriptsResult> {
  const { db } = deps;
  const result: PrepareScriptsResult = { proofread: 0, fixesApplied: 0, parsed: 0, review: [], issues: [] };
  const ids = await courseLessonOrder(db, courseId);
  if (!ids.length) return result;
  if (options.proofread && !deps.scriptProofreader) throw new Error("Proofreading isn't configured");

  const rows = await db.select().from(lessons).where(inArray(lessons.id, ids));
  const byId = new Map(rows.map((r) => [r.id, r]));

  for (const lessonId of ids) {
    let lesson = byId.get(lessonId);
    if (!lesson?.scriptText) continue; // no script yet — translation will report it as not parsed

    if (options.proofread && lesson.scriptSourceText === null) {
      try {
        const original = lesson.scriptText;
        const outcome = applyScriptCorrections(original, await deps.scriptProofreader!.proofread({ lessonId, text: original }));
        result.proofread++;
        result.review.push(...outcome.review.map((r) => ({ lessonId, original: r.original, corrected: r.corrected, reason: r.reason, why: r.why })));
        const changed = outcome.text !== original;
        if (changed && (await hasLocalizedWork(db, lessonId))) {
          result.issues.push({ lessonId, issue: `${outcome.applied.length} typo fix(es) not applied — the lesson already has translations or audio` });
          await db.update(lessons).set({ scriptSourceText: original }).where(eq(lessons.id, lessonId));
        } else {
          const now = new Date();
          [lesson] = await db
            .update(lessons)
            .set({ scriptText: outcome.text, scriptSourceText: original, ...(changed ? { scriptUpdatedAt: now } : {}), updatedAt: now })
            .where(eq(lessons.id, lessonId))
            .returning();
          if (changed) result.fixesApplied += outcome.applied.length;
        }
      } catch (err) {
        result.issues.push({ lessonId, issue: `proofreading failed: ${err instanceof Error ? err.message : String(err)}` });
      }
    }

    const neverParsed = !lesson.parsedAt;
    const stale = !!lesson.parsedAt && !!lesson.scriptUpdatedAt && lesson.scriptUpdatedAt > lesson.parsedAt;
    if (neverParsed || (stale && !(await hasLocalizedWork(db, lessonId)))) {
      try {
        await parseLessonSegments({ db, nlpService: deps.nlpService }, lessonId);
        result.parsed++;
      } catch (err) {
        result.issues.push({ lessonId, issue: `parsing failed: ${err instanceof Error ? err.message : String(err)}` });
      }
    }
    await options.onLesson?.();
  }
  return result;
}

/** Any translation or (non-superseded) audio in any language for the lesson's segments. */
async function hasLocalizedWork(db: Database, lessonId: string): Promise<boolean> {
  const segs = db.select({ id: lessonSegments.id }).from(lessonSegments).where(eq(lessonSegments.lessonId, lessonId));
  const [t] = await db.select({ id: segmentTranslations.id }).from(segmentTranslations).where(inArray(segmentTranslations.segmentId, segs)).limit(1);
  if (t) return true;
  const [c] = await db
    .select({ id: ttsClips.id })
    .from(ttsClips)
    .where(and(inArray(ttsClips.segmentId, segs), ne(ttsClips.qcStatus, "superseded")))
    .limit(1);
  return !!c;
}
