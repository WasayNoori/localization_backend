// src/routes/courses.route.ts
import type { FastifyInstance } from "fastify";
import { eq } from "drizzle-orm";
import { courses, courseLessons, lessons } from "../db/schema.js";
import { findMissingSegments } from "../services/generation/findMissingSegments.js";
import {
  importCourseStructure,
  CourseImportValidationError,
  type ImportCourseInput,
} from "../services/catalog/importCourseStructure.js";
import { getCourseStructure } from "../services/catalog/getCourseStructure.js";
import { listCourses } from "../services/catalog/listCourses.js";

const lessonImportSchema = {
  type: "object",
  required: ["id", "lessonName"],
  additionalProperties: false,
  properties: {
    id: { type: "string", minLength: 1 },
    lessonName: { type: "string", minLength: 1 },
    description: { type: "string" },
    scriptText: { type: "string" },
  },
} as const;

const sectionImportSchema = {
  type: "object",
  required: ["sectionIndex", "title", "lessons"],
  additionalProperties: false,
  properties: {
    sectionIndex: { type: "integer", minimum: 1 },
    title: { type: "string", minLength: 1 },
    lessons: { type: "array", items: lessonImportSchema },
  },
} as const;

export async function coursesRoute(app: FastifyInstance) {
  // One actor, one action: load/refresh a whole course structure in one call
  // (see docs/decisions.md, "Course structure is imported in one call").
  app.post(
    "/courses/import",
    {
      // Full scripts for a whole course can exceed Fastify's 1 MB default.
      bodyLimit: 20 * 1024 * 1024,
      schema: {
        description:
          "Idempotent upsert of a full course structure in one transaction: course → ordered sections → " +
          "ordered lessons, with optional full English scriptText per lesson. The payload is the complete " +
          "desired structure — sections/memberships missing from it are removed from this course (lessons " +
          "themselves are never deleted). Never parses: a changed script bumps script_updated_at and is " +
          "reported in needsReparse if the lesson was already parsed. 400 on duplicate section indexes or " +
          "lesson ids.",
        security: [{ apiKey: [] }],
        body: {
          type: "object",
          required: ["id", "courseName", "sections"],
          additionalProperties: false,
          properties: {
            id: { type: "string", minLength: 1 },
            courseName: { type: "string", minLength: 1 },
            status: { type: "string", enum: ["Released", "Draft"] },
            sections: { type: "array", items: sectionImportSchema },
          },
        },
      },
    },
    async (request, reply) => {
      try {
        const result = await importCourseStructure(app.db, request.body as ImportCourseInput);
        return reply.send(result);
      } catch (err) {
        if (err instanceof CourseImportValidationError) {
          return reply.code(400).send({ error: "BadRequest", message: err.message });
        }
        throw err;
      }
    }
  );

  app.get(
    "/courses",
    {
      schema: {
        description:
          "Read-only list of every course: status (Released/Draft, null until set), section/lesson/segment " +
          "counts, and per-language coverage (translated / audioReady segment counts, lessonsComplete). " +
          "Languages with no work yet are absent from coverage — treat as zero.",
        security: [{ apiKey: [] }],
      },
    },
    async (_request, reply) => reply.send(await listCourses(app.db))
  );

  app.get(
    "/courses/:courseId",
    {
      schema: {
        description:
          "Read-only course structure: ordered sections → ordered lessons, each with hasScript, parsedAt, " +
          "segmentCount and parseStale (script changed since last parse). 404 if courseId doesn't exist.",
        security: [{ apiKey: [] }],
        params: {
          type: "object",
          required: ["courseId"],
          properties: { courseId: { type: "string" } },
        },
      },
    },
    async (request, reply) => {
      const { courseId } = request.params as { courseId: string };
      const structure = await getCourseStructure(app.db, courseId);
      if (!structure) {
        return reply.code(404).send({ error: "NotFound", message: `No course with id "${courseId}"` });
      }
      return reply.send(structure);
    }
  );

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
        .orderBy(courseLessons.position, lessons.id);

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
