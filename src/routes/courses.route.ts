// src/routes/courses.route.ts
import type { FastifyInstance } from "fastify";
import { eq } from "drizzle-orm";
import { courses, courseLessons, lessons } from "../db/schema.js";
import { findMissingSegments } from "../services/generation/findMissingSegments.js";

export async function coursesRoute(app: FastifyInstance) {
  // Read-only reporting — no DeepL/ElevenLabs calls, no writes. Reuses the
  // same missing-segments query as generateLocalizationForLesson (see
  // docs/pipeline-flow.md, generate-stage section), so "complete" here means
  // exactly what that generate endpoint would consider already-done.
  app.get(
    "/courses/:courseId/localizations/:targetLanguage/status",
    {
      schema: {
        description:
          "Read-only completeness report for a course + target language — no DeepL/ElevenLabs calls, no " +
          "writes. For each lesson in the course, reports whether every segment has an active tts_clips " +
          "row for this language (via the same findMissingSegments query generateLocalizationForLesson " +
          "uses) and how many are still missing. courseComplete is true iff every lesson is complete " +
          "(vacuously true for a course with no lessons, matching a lesson with no segments being " +
          "vacuously complete). 404 if courseId doesn't exist.",
        security: [{ apiKey: [] }],
        params: {
          type: "object",
          required: ["courseId", "targetLanguage"],
          properties: {
            courseId: { type: "string" },
            targetLanguage: { type: "string" },
          },
        },
      },
    },
    async (request, reply) => {
      const { courseId, targetLanguage } = request.params as {
        courseId: string;
        targetLanguage: string;
      };

      const [course] = await app.db.select().from(courses).where(eq(courses.id, courseId)).limit(1);
      if (!course) {
        return reply.code(404).send({ error: "NotFound", message: `No course with id "${courseId}"` });
      }

      const lessonRows = await app.db
        .select({ lessonId: lessons.id })
        .from(courseLessons)
        .innerJoin(lessons, eq(courseLessons.lessonId, lessons.id))
        .where(eq(courseLessons.courseId, courseId))
        .orderBy(lessons.id);

      const lessonStatuses = await Promise.all(
        lessonRows.map(async ({ lessonId }) => {
          const { missingSegments } = await findMissingSegments(app.db, lessonId, targetLanguage);
          return {
            lessonId,
            complete: missingSegments.length === 0,
            missingSegments: missingSegments.length,
          };
        })
      );

      return reply.send({
        courseId,
        targetLanguage,
        lessons: lessonStatuses,
        courseComplete: lessonStatuses.every((l) => l.complete),
      });
    }
  );
}
