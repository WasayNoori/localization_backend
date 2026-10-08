// src/services/jobs/courseTranslationJob.ts
import { and, eq, inArray } from "drizzle-orm";
import type { Database } from "../../db/client.js";
import { processingJobs, type ProcessingJobProgress } from "../../db/schema.js";
import type { INlpService } from "../../interfaces/INlpService.js";
import type { IScriptProofreader } from "../../interfaces/IScriptProofreader.js";
import { prepareCourseScripts } from "../translation/prepareCourseScripts.js";
import {
  assertTranslatableCourse,
  courseLessonOrder,
  translateCourseLessons,
  type CourseTranslationMode,
} from "../translation/translateCourseLessons.js";
import type { TranslateLessonDeps } from "../translation/translateLessonSegments.js";
import { translateCourseScaffolding } from "../translation/translateScaffolding.js";

export type ProcessingJob = typeof processingJobs.$inferSelect;

export type CourseTranslationJobDeps = TranslateLessonDeps & { nlpService: INlpService; scriptProofreader: IScriptProofreader };

export interface CourseTranslationOptions {
  mode?: CourseTranslationMode;
  /** Typo-check scripts (Claude) before parsing — scripts not checked yet only. */
  proofread?: boolean;
}

export class JobConflictError extends Error {
  constructor(public readonly job: ProcessingJob) {
    super(`A ${job.type} job for ${job.targetId} (${job.targetLanguage}) is already ${job.status}`);
  }
}

/**
 * Translation jobs of one course run one after another (in this process), so
 * two languages never proofread or re-cut the same lesson at once. A job
 * waiting its turn is "pending".
 */
const courseQueues = new Map<string, Promise<void>>();

/**
 * "Translate this course into one language" as a processing_jobs row, run in
 * the background in this process. Returns at once; poll GET /jobs/:jobId.
 * Steps: (1) get the scripts ready — typo check if asked, then parse what
 * isn't parsed (shared by all languages; idempotent); (2) the scaffolding
 * (course/section/lesson names, descriptions — missing or stale only);
 * (3) the scripts. One active job per course + language; jobs of the same
 * course queue behind each other.
 */
export async function startCourseTranslationJob(
  deps: CourseTranslationJobDeps,
  courseId: string,
  targetLanguage: string,
  options: CourseTranslationOptions = {}
): Promise<ProcessingJob> {
  const { db } = deps;
  await assertTranslatableCourse(db, courseId, targetLanguage);

  const [active] = await db
    .select()
    .from(processingJobs)
    .where(
      and(
        eq(processingJobs.scope, "course"),
        eq(processingJobs.type, "translate"),
        eq(processingJobs.targetId, courseId),
        eq(processingJobs.targetLanguage, targetLanguage),
        inArray(processingJobs.status, ["pending", "running"])
      )
    )
    .limit(1);
  if (active) throw new JobConflictError(active);

  const total = (await courseLessonOrder(db, courseId)).length;
  const [job] = await db
    .insert(processingJobs)
    .values({
      scope: "course",
      targetId: courseId,
      type: "translate",
      targetLanguage,
      status: "pending",
      progress: {
        total,
        succeeded: [],
        failed: [],
        skipped: [],
        phase: "queued",
        options: { mode: options.mode ?? "missing", proofread: String(!!options.proofread) },
      },
    })
    .returning();

  const previous = courseQueues.get(courseId) ?? Promise.resolve();
  const mine = previous.then(() => runCourseTranslationJob(deps, job)).catch(() => {
    // runCourseTranslationJob records its own failure.
  });
  courseQueues.set(courseId, mine);
  void mine.finally(() => {
    if (courseQueues.get(courseId) === mine) courseQueues.delete(courseId);
  });
  return job;
}

async function runCourseTranslationJob(deps: CourseTranslationJobDeps, job: ProcessingJob): Promise<void> {
  const { db } = deps;
  const language = job.targetLanguage!;
  const mode = (job.progress.options?.mode as CourseTranslationMode | undefined) ?? "missing";
  const proofread = job.progress.options?.proofread === "true";
  let progress: ProcessingJobProgress = { ...job.progress, notes: [], review: [] };
  const save = (status: string) =>
    db.update(processingJobs).set({ progress, status, updatedAt: new Date() }).where(eq(processingJobs.id, job.id));

  try {
    // 1. Scripts ready: typo check (optional) + parse what isn't parsed.
    progress = { ...progress, phase: proofread ? "checking scripts" : "preparing scripts" };
    await save("running");
    const prep = await prepareCourseScripts(deps, job.targetId, { proofread });
    progress = {
      ...progress,
      stats: { proofread: prep.proofread, fixesApplied: prep.fixesApplied, parsed: prep.parsed },
      review: prep.review,
      notes: prep.issues.map((i) => ({ lessonId: i.lessonId, note: i.issue })),
    };

    // 2. Scaffolding — names and descriptions (missing or stale only).
    progress = { ...progress, phase: "translating names and descriptions" };
    await save("running");
    try {
      const sc = await translateCourseScaffolding(deps, job.targetId, language, "missing");
      if (sc.review.flagged) progress.notes!.push({ lessonId: "", note: `${sc.review.flagged} name/description translation(s) flagged by the reviewer — see the course page` });
      if (sc.review.error) progress.notes!.push({ lessonId: "", note: `scaffolding review failed (translations saved, unreviewed): ${sc.review.error}` });
    } catch (err) {
      progress.notes!.push({ lessonId: "", note: `names and descriptions not translated: ${err instanceof Error ? err.message : String(err)}` });
    }

    // 3. Scripts.
    progress = { ...progress, phase: "translating scripts" };
    await save("running");
    const result = await translateCourseLessons(deps, job.targetId, language, {
      mode,
      onProgress: async (p) => {
        progress = { ...progress, succeeded: p.succeeded, failed: p.failed, skipped: p.skipped };
        await save("running");
      },
    });
    const { stopped: _stopped, ...lessonsProgress } = result;
    progress = { ...progress, ...lessonsProgress, phase: "done" };
    // Settled rule (pipeline-flow.md): any failed lesson → "failed"; succeeded still lists what was done.
    await save(progress.failed.length ? "failed" : "completed");
  } catch (err) {
    progress = { ...progress, error: err instanceof Error ? err.message : String(err) };
    await save("failed");
    throw err;
  }
}

/**
 * Jobs run in-process, so a restart kills them mid-way. Called at startup:
 * any job still pending/running is marked failed with a reason. Re-running a
 * course translation with mode "missing" continues where it stopped.
 */
export async function failInterruptedJobs(db: Database): Promise<number> {
  const stuck = await db.select().from(processingJobs).where(inArray(processingJobs.status, ["pending", "running"]));
  for (const job of stuck) {
    await db
      .update(processingJobs)
      .set({
        status: "failed",
        progress: { ...job.progress, error: "Interrupted: the server restarted while this job was running. Start it again to continue." },
        updatedAt: new Date(),
      })
      .where(eq(processingJobs.id, job.id));
  }
  return stuck.length;
}
