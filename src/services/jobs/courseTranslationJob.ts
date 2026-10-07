// src/services/jobs/courseTranslationJob.ts
import { and, eq, inArray } from "drizzle-orm";
import type { Database } from "../../db/client.js";
import { processingJobs, type ProcessingJobProgress } from "../../db/schema.js";
import {
  assertTranslatableCourse,
  courseLessonOrder,
  translateCourseLessons,
  type CourseTranslationMode,
} from "../translation/translateCourseLessons.js";
import type { TranslateLessonDeps } from "../translation/translateLessonSegments.js";

export type ProcessingJob = typeof processingJobs.$inferSelect;

export class JobConflictError extends Error {
  constructor(public readonly job: ProcessingJob) {
    super(`A ${job.type} job for ${job.targetId} (${job.targetLanguage}) is already ${job.status}`);
  }
}

/**
 * Starts "translate this course into one language" as a processing_jobs row
 * and runs it in the background in this process (no queue yet). Returns the
 * job immediately; poll GET /jobs/:jobId. One active job per course +
 * language. Progress is written after every lesson, so a poll always shows
 * real counts.
 */
export async function startCourseTranslationJob(
  deps: TranslateLessonDeps,
  courseId: string,
  targetLanguage: string,
  mode: CourseTranslationMode = "missing"
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
      status: "running",
      progress: { total, succeeded: [], failed: [], skipped: [], options: { mode } },
    })
    .returning();

  void runCourseTranslationJob(deps, job).catch(() => {
    // runCourseTranslationJob records its own failure; nothing else to do here.
  });
  return job;
}

async function runCourseTranslationJob(deps: TranslateLessonDeps, job: ProcessingJob): Promise<void> {
  const { db } = deps;
  const mode = (job.progress.options?.mode as CourseTranslationMode | undefined) ?? "missing";
  const save = async (progress: ProcessingJobProgress, status: string): Promise<void> => {
    await db.update(processingJobs).set({ progress, status, updatedAt: new Date() }).where(eq(processingJobs.id, job.id));
  };
  try {
    const result = await translateCourseLessons(deps, job.targetId, job.targetLanguage!, {
      mode,
      onProgress: (p) => save({ ...p, options: job.progress.options }, "running"),
    });
    const { stopped: _stopped, ...progress } = result;
    // Settled rule (pipeline-flow.md): any failed lesson → "failed"; succeeded still lists what was done.
    await save({ ...progress, options: job.progress.options }, progress.failed.length ? "failed" : "completed");
  } catch (err) {
    await save({ ...job.progress, error: err instanceof Error ? err.message : String(err) }, "failed");
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
