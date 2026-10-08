// src/modules/quiz/quizTranslationJob.ts
import { and, eq, inArray } from "drizzle-orm";
import type { Database } from "../../db/client.js";
import { processingJobs, type ProcessingJobProgress } from "../../db/schema.js";
import { JobConflictError, type ProcessingJob } from "../../services/jobs/courseTranslationJob.js";
import type { IQuizCourseContext, IQuizOutputStore, IQuizSource } from "./interfaces.js";
import { translateQuizQuestions, type TranslateQuizDeps } from "./translateQuizQuestions.js";

export const QUIZ_JOB_TYPE = "quiz";

export interface QuizJobDeps extends TranslateQuizDeps {
  db: Database;
  courseContext: IQuizCourseContext;
  source: IQuizSource;
  output: IQuizOutputStore;
}

export class QuizJobError extends Error {
  constructor(
    public readonly statusCode: 400 | 404,
    message: string
  ) {
    super(message);
  }
}

/** Quiz jobs of one course run one after another (in-process), in the order started. */
const courseQueues = new Map<string, Promise<void>>();

/**
 * "Translate this course's quiz into one language" as a processing_jobs row
 * (type "quiz"). Stateless: reads the source (the course's Monday board),
 * translates every question, writes the language's .xlsx to the course's Box
 * folder, replacing the previous one. Returns the job at once; poll GET /jobs/:jobId.
 */
export async function startQuizTranslationJob(
  deps: QuizJobDeps,
  courseId: string,
  language: string,
  options: { review: boolean }
): Promise<ProcessingJob> {
  const { db } = deps;
  if (language === "en") throw new QuizJobError(400, "Quizzes are written in English — pick a target language");
  const course = await deps.courseContext.getCourse(courseId);
  if (!course) throw new QuizJobError(404, `No course with id "${courseId}"`);
  if (!course.mondayBoardId) throw new QuizJobError(400, `Course "${courseId}" has no Monday board — set it on the course's Edit details page`);
  if (!course.boxFolderId) throw new QuizJobError(400, `Course "${courseId}" has no Box folder — set it on the course's Edit details page`);

  const [active] = await db
    .select()
    .from(processingJobs)
    .where(
      and(
        eq(processingJobs.scope, "course"),
        eq(processingJobs.type, QUIZ_JOB_TYPE),
        eq(processingJobs.targetId, courseId),
        eq(processingJobs.targetLanguage, language),
        inArray(processingJobs.status, ["pending", "running"])
      )
    )
    .limit(1);
  if (active) throw new JobConflictError(active);

  const [job] = await db
    .insert(processingJobs)
    .values({
      scope: "course",
      targetId: courseId,
      type: QUIZ_JOB_TYPE,
      targetLanguage: language,
      status: "pending",
      progress: { total: 0, succeeded: [], failed: [], skipped: [], phase: "queued", options: { review: String(options.review) } },
    })
    .returning();

  const previous = courseQueues.get(courseId) ?? Promise.resolve();
  const mine = previous.then(() => runQuizTranslationJob(deps, job, options)).catch(() => {
    // runQuizTranslationJob records its own failure.
  });
  courseQueues.set(courseId, mine);
  void mine.finally(() => {
    if (courseQueues.get(courseId) === mine) courseQueues.delete(courseId);
  });
  return job;
}

async function runQuizTranslationJob(deps: QuizJobDeps, job: ProcessingJob, options: { review: boolean }): Promise<void> {
  const { db } = deps;
  const language = job.targetLanguage!;
  let progress: ProcessingJobProgress = { ...job.progress, phase: "reading questions" };
  const save = (status: string) =>
    db.update(processingJobs).set({ progress, status, updatedAt: new Date() }).where(eq(processingJobs.id, job.id));

  try {
    await save("running");
    const course = await deps.courseContext.getCourse(job.targetId);
    if (!course) throw new Error(`Course "${job.targetId}" no longer exists`);
    const { questions, description } = await deps.source.readQuestions(course);
    progress = { ...progress, total: questions.length, phase: "translating" };
    await save("running");

    const result = await translateQuizQuestions(deps, course, questions, language, {
      review: options.review,
      onProgress: async (done) => {
        if (done % 10 && done !== questions.length) return; // save every 10 questions
        progress = { ...progress, succeeded: questions.slice(0, done).map((q) => q.qqId ?? q.sourceItemId) };
        await save("running");
      },
    });

    progress = { ...progress, phase: "writing file" };
    await save("running");
    const file = await deps.output.write({ course, language, questions: result.questions, sourceDescription: description, generatedAt: new Date() });

    progress = {
      ...progress,
      phase: "done",
      stats: { ...result.stats },
      options: { ...progress.options, file: file.path, fileId: file.fileId },
      notes: result.questions
        .filter((r) => r.flags.length)
        .map((r) => ({ lessonId: r.lessonId, note: `QQ ${r.source.qqId ?? "?"}: ${r.flags.join(" · ")}` })),
    };
    await save("completed");
  } catch (err) {
    progress = { ...progress, error: err instanceof Error ? err.message : String(err) };
    await save("failed");
    throw err;
  }
}
