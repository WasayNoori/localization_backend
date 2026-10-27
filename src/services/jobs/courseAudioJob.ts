// src/services/jobs/courseAudioJob.ts
import { auditCourseAudio } from "../audit/auditCourseAudio.js";
import { and, eq, inArray } from "drizzle-orm";
import { courses, processingJobs, type ProcessingJobProgress } from "../../db/schema.js";
import type { ICourseAuditCheck } from "../../interfaces/ICourseAuditCheck.js";
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
  /** Course-level audit checks (outline, quiz…) — see auditCourseAudio. */
  courseAuditChecks?: ICourseAuditCheck[];
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
 * the job at once; poll GET /jobs/:jobId. Into the course's Box folder, per
 * lesson: "<Language> Segments.txt", then the missing clips — the same
 * per-lesson generate loop as the lesson endpoint, so re-running continues
 * where it stopped. Writing each lesson's file right before its clips means a
 * lesson whose translation finished mid-run still gets one. `segmentsOnly`
 * writes the Segments.txt files and stops (no voice needed, no ElevenLabs,
 * no audit); `scriptOnly` does the same with "<Language> Script.txt". Lessons not fully translated are skipped (no DeepL calls). One
 * active job per course + language (either kind — they write the same files).
 */
/**
 * Audio jobs of one course run one after another, in the order requested
 * (the console starts English first, then each target). One language finishes
 * the whole course before the next starts; a job waiting its turn is "pending".
 * In-process, like the translation queue — a separate worker replaces both.
 */
const courseAudioQueues = new Map<string, Promise<void>>();

export interface CourseAudioJobOptions {
  /** Write the Segments.txt files only — no clips, no audit. */
  segmentsOnly?: boolean;
  /** Write the Script.txt files only (full script, unnumbered) — no clips, no audit. */
  scriptOnly?: boolean;
}

export async function startCourseAudioJob(
  deps: CourseAudioJobDeps,
  courseId: string,
  language: string,
  options: CourseAudioJobOptions = {}
): Promise<ProcessingJob> {
  const { db } = deps;
  const [course] = await db.select().from(courses).where(eq(courses.id, courseId)).limit(1);
  if (!course) throw new CourseAudioJobError(404, `No course with id "${courseId}"`);
  if (!course.boxFolderId) throw new CourseAudioJobError(400, `Course "${courseId}" has no Box folder — set it on the course page`);
  // Fails here (400) for a language without a voice, rather than inside the job.
  if (options.segmentsOnly && options.scriptOnly) throw new CourseAudioJobError(400, "Give segmentsOnly or scriptOnly, not both");
  const textOnly: TextOnlyFile | null = options.segmentsOnly ? "segments" : options.scriptOnly ? "script" : null;
  if (!textOnly) await deps.voiceSettingsProvider.getSettings(language);

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
      progress: { total, succeeded: [], failed: [], skipped: [], phase: "queued", options: { boxFolderId: course.boxFolderId, ...(textOnly ? { [`${textOnly}Only`]: "true" } : {}) } },
    })
    .returning();

  const boxFolderId = course.boxFolderId;
  const previous = courseAudioQueues.get(courseId) ?? Promise.resolve();
  const mine = previous.then(() => runCourseAudioJob(deps, job, boxFolderId, textOnly)).catch(() => {
    // runCourseAudioJob records its own failure.
  });
  courseAudioQueues.set(courseId, mine);
  void mine.finally(() => {
    if (courseAudioQueues.get(courseId) === mine) courseAudioQueues.delete(courseId);
  });
  return job;
}

/** The text file a text-only job writes. */
type TextOnlyFile = "segments" | "script";

async function runCourseAudioJob(deps: CourseAudioJobDeps, job: ProcessingJob, boxFolderId: string, textOnly: TextOnlyFile | null): Promise<void> {
  const { db } = deps;
  const language = job.targetLanguage!;
  const fileLabel = textOnly === "script" ? "Script.txt" : "Segments.txt";
  let progress: ProcessingJobProgress = {
    ...job.progress,
    phase: textOnly ? `writing ${fileLabel}` : "generating",
    stats: textOnly === "script" ? { scriptFiles: 0 } : textOnly ? { segmentFiles: 0 } : { segmentFiles: 0, clips: 0, characters: 0 },
  };
  const save = (status: string) =>
    db.update(processingJobs).set({ progress, status, updatedAt: new Date() }).where(eq(processingJobs.id, job.id));
  const outputStore = new BoxLessonOutputStore(deps.fileStorageService, boxFolderId);
  /** Writes Segments.txt for the given lessons (default: all); a file not written is listed with why. */
  const writeSegments = async (lessonIds?: string[]) => {
    const result = await writeCourseSegmentsFiles({ db, outputStore }, job.targetId, { languages: [language], courseFolder: job.targetId, lessonIds });
    progress.stats!.segmentFiles += result.written.length;
    return result;
  };

  try {
    await save("running");
    if (textOnly) {
      const result =
        textOnly === "script"
          ? await writeCourseSegmentsFiles({ db, outputStore }, job.targetId, { languages: [language], courseFolder: job.targetId, file: "script" })
          : await writeSegments();
      if (textOnly === "script") progress.stats!.scriptFiles = result.written.length;
      progress = {
        ...progress,
        succeeded: result.written.map((w) => w.lessonId),
        skipped: result.skipped.map((s) => ({ lessonId: s.lessonId, reason: `${fileLabel} not written: ${s.reason}` })),
        phase: "done",
      };
      await save("completed");
      return;
    }

    await generateCourseAudio({ ...deps, clipStore: new BoxClipStore(deps.fileStorageService), boxFolderId, courseFolder: null }, job.targetId, language, {
      beforeLesson: async (lessonId) => {
        // Not written = the lesson is skipped below too (not parsed / not fully translated), with that reason.
        await writeSegments([lessonId]);
      },
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
    // Audit: every lesson has a Box clip per segment, its Segments.txt, nothing out of place.
    progress = { ...progress, phase: "auditing" };
    await save("running");
    try {
      const { courseId: _c, language: _l, ...audit } = await auditCourseAudio(deps, job.targetId, language);
      progress = { ...progress, audit };
    } catch (err) {
      progress = { ...progress, error: `Audit couldn't run: ${err instanceof Error ? err.message : String(err)}` };
    }
    // Any failed lesson, a failed audit or an audit that couldn't run → "failed"; succeeded still lists what was done.
    progress = { ...progress, phase: "done" };
    await save(progress.failed.length || !progress.audit?.ok ? "failed" : "completed");
  } catch (err) {
    progress = { ...progress, error: err instanceof Error ? err.message : String(err) };
    await save("failed");
    throw err;
  }
}
