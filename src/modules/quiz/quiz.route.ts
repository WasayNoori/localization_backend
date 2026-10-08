// src/modules/quiz/quiz.route.ts
import type { FastifyInstance } from "fastify";
import { JobConflictError } from "../../services/jobs/courseTranslationJob.js";
import { QuizSourceError } from "./interfaces.js";
import { QuizJobError, startQuizTranslationJob, type QuizJobDeps } from "./quizTranslationJob.js";

const courseParams = { type: "object", required: ["courseId"], properties: { courseId: { type: "string" } } } as const;

export function quizRoutes(deps: QuizJobDeps) {
  return async function (app: FastifyInstance) {
    app.get(
      "/courses/:courseId/quiz",
      {
        schema: {
          description:
            "Quiz module — what a quiz translation would work from: reads the course's quiz source (its Monday " +
            "board's \"Quiz Questions\" group) and returns the question count, counts per review status and lessons " +
            "not in the course. Read-only. 400 no Monday board / source unreadable, 404 unknown course.",
          tags: ["quiz"],
          security: [{ apiKey: [] }],
          params: courseParams,
        },
      },
      async (request, reply) => {
        const { courseId } = request.params as { courseId: string };
        const course = await deps.courseContext.getCourse(courseId);
        if (!course) return reply.code(404).send({ error: "NotFound", message: `No course with id "${courseId}"` });
        try {
          const { questions, description } = await deps.source.readQuestions(course);
          const lessonIds = new Set(course.lessons.map((l) => l.id.toLowerCase()));
          const byStatus: Record<string, number> = {};
          for (const q of questions) byStatus[q.reviewStatus ?? "(none)"] = (byStatus[q.reviewStatus ?? "(none)"] ?? 0) + 1;
          return reply.send({
            courseId,
            source: description,
            questions: questions.length,
            byStatus,
            withoutQuestionText: questions.filter((q) => !q.question).map((q) => q.qqId ?? q.sourceItemId),
            lessonsNotInCourse: [...new Set(questions.map((q) => q.lessonRef).filter((ref) => !lessonIds.has(ref.toLowerCase())))],
          });
        } catch (err) {
          if (err instanceof QuizSourceError) return reply.code(400).send({ error: "BadRequest", message: err.message });
          throw err;
        }
      }
    );

    app.post(
      "/courses/:courseId/quiz/translations/:targetLanguage",
      {
        schema: {
          description:
            "Quiz module — translates the course's quiz into one language: reads every question from the course's " +
            "Monday board (\"Quiz Questions\" group), translates question + answer options together (glossary, " +
            "formality; TRUE/FALSE fixed words), optional Claude check (`review`, default true), and writes " +
            "<LANG>/Quiz Questions/<courseId> Quiz Questions <LANG>.xlsx to the course's Box folder (replacing the " +
            "previous file; Box keeps versions). Stores nothing about quizzes. Async — 202 { jobId, job }; poll " +
            "GET /jobs/:jobId (stats: questions, translated, characters, flagged; notes: flagged questions; " +
            "options.file). 400 English / no Monday board / no Box folder, 404, 409 already running.",
          tags: ["quiz"],
          security: [{ apiKey: [] }],
          params: {
            type: "object",
            required: ["courseId", "targetLanguage"],
            properties: { courseId: { type: "string" }, targetLanguage: { type: "string" } },
          },
          body: { type: "object", additionalProperties: false, properties: { review: { type: "boolean" } } },
        },
        preValidation: async (request) => {
          if (request.body === undefined || request.body === null) request.body = {};
        },
      },
      async (request, reply) => {
        const { courseId, targetLanguage } = request.params as { courseId: string; targetLanguage: string };
        const { review = true } = request.body as { review?: boolean };
        try {
          const job = await startQuizTranslationJob(deps, courseId, targetLanguage.toLowerCase(), { review });
          return reply.code(202).send({ jobId: job.id, job });
        } catch (err) {
          if (err instanceof JobConflictError) {
            return reply.code(409).send({ error: "Conflict", message: err.message, jobId: err.job.id, job: err.job });
          }
          if (err instanceof QuizJobError) {
            return reply.code(err.statusCode).send({ error: err.statusCode === 404 ? "NotFound" : "BadRequest", message: err.message });
          }
          throw err;
        }
      }
    );
  };
}
