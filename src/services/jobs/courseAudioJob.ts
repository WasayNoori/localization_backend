// src/services/jobs/courseAudioJob.ts
import { and, eq, inArray } from "drizzle-orm";
import { courses, processingJobs, type ProcessingJobProgress } from "../../db/schema.js";
import type { IFileStorageService } from "../../interfaces/IFileStorageService.js";
import { generateCourseAudio } from "../generation/generateCourseAudio.js";
import type { GenerateLocalizationDeps } from "../generation/generateLocalizationForLesson.js";
import { BoxClipStore } from "../output/BoxClipStore.js";
import { BoxLessonOutputStore } from "../output/BoxLessonOutputStore.js";
import { writeCourseSegmentsFiles } from "../output/writeCourseSegmentsFiles.js";
import { courseLessonOrder } from "../translation/translateCourseLessons.js";
import { JobConflictError, type ProcessingJob } from "./courseTranslationJob.js";

export type CourseAudioJobDeps = Omit<GenerateLocalizationDeps, "clipStore" | "boxFolderId" | "courseFolder"> & {
  fileStorageService: IFileStorageService;
};

export class CourseAudioJobError extends Error {
  constructor(
    public readonly statusCode: 400 | 404,
    message: string
  ) {
    super(message);
  }
}

/**
 * Starts "generate the audio for this course in one language" as a
 * processing_jobs row (type "generate") and runs it in this process. Returns
 * the job at once; poll GET /jobs/:jobId. Into the course's Box folder:
 *   1. "<Language> Segments.txt" for every lesson (unchanged files are skipped),
 *   2. the missing clips — the same per-lesson generate loop as the lesson
 *      endpoint, so re-running continues where it stopped.
 * Lessons not fully translated are skipped (no DeepL calls). One active job
 * per course + language.
 */
/**
 * Audio jobs of one course run one after another, in the order requested
 * (the console starts English first, then each target). One language finishes
 * the whole course before the next starts; a job waiting its turn is "pending".
 * In-process, like the translation queue — a separate worker replaces both.
 */
const courseAudioQueues = new Map<string, Promise<void>>();

export async function startCourseAudioJob(deps: CourseAudioJobDeps, courseId: string, language: string): Promise<ProcessingJob> {
  const { db } = deps;
  const [course] = await db.select().from(courses).where(eq(courses.id, courseId)).limit(1);
  if (!course) throw new CourseAudioJobError(404, `No course with id "${courseId}"`);
  if (!course.boxFolderId) throw new CourseAudioJobError(400, `Course "${courseId}" has no Box folder — set it on the course page`);
  // Fails here (400) for a language without a voice, rather than inside the job.
  await deps.voiceSettingsProvider.getSettings(language);

  const [active] = await db
    .select()
    .from(processingJobs)
    .where(
      and(
        eq(processingJobs.scope, "course"),
        eq(processingJobs.type, "generate"),
        eq(processingJobs.targetId, courseId),
        eq(processingJobs.targetLanguage, language),
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
      type: "generate",
      targetLanguage: language,
      status: "pending",
      progress: { total, succeeded: [], failed: [], skipped: [], phase: "queued", options: { boxFolderId: course.boxFolderId } },
    })
    .returning();

  const boxFolderId = course.boxFolderId;
  const previous = courseAudioQueues.get(courseId) ?? Promise.resolve();
  const mine = previous.then(() => runCourseAudioJob(deps, job, boxFolderId)).catch(() => {
    // runCourseAudioJob records its own failure.
  });
  courseAudioQueues.set(courseId, mine);
  void mine.finally(() => {
    if (courseAudioQueues.get(courseId) === mine) courseAudioQueues.delete(courseId);
  });
  return job;
}

async function runCourseAudioJob(deps: CourseAudioJobDeps, job: ProcessingJob, boxFolderId: string): Promise<void> {
  const { db } = deps;
  const language = job.targetLanguage!;
  let progress: ProcessingJobProgress = { ...job.progress, phase: "generating", stats: { segmentFiles: 0, clips: 0, characters: 0 } };
  const save = (status: string) =>
    db.update(processingJobs).set({ progress, status, updatedAt: new Date() }).where(eq(processingJobs.id, job.id));

  try {
    await save("running");
    const segments = await writeCourseSegmentsFiles(
      { db, outputStore: new BoxLessonOutputStore(deps.fileStorageService, boxFolderId) },
      job.targetId,
      { languages: [language], courseFolder: job.targetId }
    );
    progress = { ...progress, stats: { ...progress.stats, segmentFiles: segments.written.length } };
    await save("running");

    await generateCourseAudio({ ...deps, clipStore: new BoxClipStore(deps.fileStorageService), boxFolderId, courseFolder: null }, job.targetId, language, {
      onLesson: async (lesson) => {
        const stats = progress.stats!;
        stats.clips += lesson.generated;
        stats.characters += lesson.generated ? lesson.characters : 0;
        if (lesson.skipped) {
          progress.skipped = [...(progress.skipped ?? []), { lessonId: lesson.lessonId, reason: lesson.skipped }];
        } else if (lesson.errors.length) {
          progress.failed = [
            ...progress.failed,
            { lessonId: lesson.lessonId, error: `${lesson.errors.length} of ${lesson.missing} clips failed: ${lesson.errors[0].error}` },
          ];
        } else {
          progress.succeeded = [...progress.succeeded, lesson.lessonId];
        }
        await save("running");
      },
    });
    // Same rule as translation jobs: any failed lesson → "failed"; succeeded still lists what was done.
    await save(progress.failed.length ? "failed" : "completed");
  } catch (err) {
    progress = { ...progress, error: err instanceof Error ? err.message : String(err) };
    await save("failed");
    throw err;
  }
}
