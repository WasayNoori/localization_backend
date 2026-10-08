// src/routes/courses.route.ts
import type { FastifyInstance } from "fastify";
import {
  createCourse,
  updateCourseDetails,
  CourseDetailsError,
  type CourseDetailsInput,
  type NewCourseInput,
} from "../services/catalog/saveCourseDetails.js";
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
import { defaultEmptyBody } from "./default-empty-body.js";
import {
  translateCourseScaffolding,
  TranslateScaffoldingError,
  type ScaffoldingMode,
} from "../services/translation/translateScaffolding.js";
import { writeCourseSegmentsFiles, WriteSegmentsError } from "../services/output/writeCourseSegmentsFiles.js";
import { startCourseAudioJob, CourseAudioJobError } from "../services/jobs/courseAudioJob.js";
import { auditCourseAudio, AuditError } from "../services/audit/auditCourseAudio.js";
import { VoiceNotConfiguredError } from "../interfaces/IvoiceSettingsProvider.js";
import { startCourseTranslationJob, JobConflictError } from "../services/jobs/courseTranslationJob.js";
import { TranslateCourseError, type CourseTranslationMode } from "../services/translation/translateCourseLessons.js";
import { correctScaffolding, type ScaffoldingCorrections } from "../services/translation/correctScaffolding.js";
import { updateCourseScripts, CourseScriptsError, type CourseScriptInput } from "../services/catalog/updateCourseScripts.js";

const dryRunQuerystring = {
  type: "object",
  properties: { dryRun: { type: "boolean" } },
} as const;

const lessonImportSchema = {
  type: "object",
  required: ["id", "lessonName"],
  additionalProperties: false,
  properties: {
    id: { type: "string", minLength: 1 },
    lessonName: { type: "string", minLength: 1 },
    description: { type: "string" },
    tags: { type: "array", items: { type: "string" } },
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
      schema: {
        description:
          "Idempotent upsert of a full course structure in one transaction: course details → ordered sections → " +
          "ordered lessons (names, descriptions, tags). Structure and metadata only — scripts come through " +
          "PUT /courses/:courseId/scripts (the console's script-file upload). The payload is the complete " +
          "desired structure — sections/memberships missing from it are removed from this course (lessons " +
          "themselves are never deleted). 400 on duplicate section indexes or " +
          "lesson ids. ?dryRun=true runs the same writes and rolls them back — a preview that returns the same " +
          "result shape (sectionsAdded/Removed, lessonsCreated/Updated/Unchanged/RemovedFromCourse, …) with " +
          "dryRun: true and nothing saved.",
        security: [{ apiKey: [] }],
        querystring: dryRunQuerystring,
        body: {
          type: "object",
          required: ["id", "courseName", "sections"],
          additionalProperties: false,
          properties: {
            id: { type: "string", minLength: 1 },
            courseName: { type: "string", minLength: 1 },
            description: { type: "string" },
            status: { type: "string", enum: ["Released", "Draft"] },
            boxFolderId: { type: "string" },
            sections: { type: "array", items: sectionImportSchema },
          },
        },
      },
    },
    async (request, reply) => {
      try {
        const { dryRun } = request.query as { dryRun?: boolean };
        const result = await importCourseStructure(app.db, request.body as ImportCourseInput, { dryRun });
        return reply.send(result);
      } catch (err) {
        if (err instanceof CourseImportValidationError) {
          return reply.code(400).send({ error: "BadRequest", message: err.message });
        }
        throw err;
      }
    }
  );

  const courseDetailsProperties = {
    courseName: { type: "string", minLength: 1 },
    description: { type: "string" },
    status: { type: "string", enum: ["Released", "Draft"] },
    boxFolderId: { type: "string" },
  } as const;

  app.post(
    "/courses",
    {
      schema: {
        description:
          "Creates a course with its details only (id, name, description, status, Box folder) — sections and " +
          "lessons come in through POST /courses/import. The id is also the lesson-id prefix (25Sim → 25Sim01_01) " +
          "and can't change later: letters, digits, '-', '_'. boxFolderId is the course's top-level Box folder " +
          "(numeric). 201 created, 400 invalid, 409 id taken.",
        security: [{ apiKey: [] }],
        body: {
          type: "object",
          required: ["id", "courseName"],
          additionalProperties: false,
          properties: { id: { type: "string", minLength: 1 }, ...courseDetailsProperties },
        },
      },
    },
    async (request, reply) => {
      try {
        return reply.code(201).send(await createCourse(app.db, request.body as NewCourseInput));
      } catch (err) {
        if (err instanceof CourseDetailsError) return reply.code(err.statusCode).send({ error: "BadRequest", message: err.message });
        throw err;
      }
    }
  );

  app.patch(
    "/courses/:courseId",
    {
      schema: {
        description:
          "Edits a course's details: name, description (\"\" clears), status, boxFolderId (\"\" clears). " +
          "Omitted fields are unchanged; the id can't be changed. 400 invalid, 404 unknown course.",
        security: [{ apiKey: [] }],
        params: { type: "object", required: ["courseId"], properties: { courseId: { type: "string" } } },
        body: { type: "object", additionalProperties: false, properties: courseDetailsProperties },
      },
    },
    async (request, reply) => {
      const { courseId } = request.params as { courseId: string };
      try {
        return reply.send(await updateCourseDetails(app.db, courseId, request.body as CourseDetailsInput));
      } catch (err) {
        if (err instanceof CourseDetailsError) {
          return reply.code(err.statusCode).send({ error: err.statusCode === 404 ? "NotFound" : "BadRequest", message: err.message });
        }
        throw err;
      }
    }
  );

  // Different action from import (scripts arrive separately, often later),
  // and a partial payload must not touch structure — hence its own endpoint.
  app.put(
    "/courses/:courseId/scripts",
    {
      bodyLimit: 20 * 1024 * 1024,
      schema: {
        description:
          "Scripts-only upload for lessons already in the course: sets lessons.script_text (bumping " +
          "script_updated_at when the text actually changes). Structure and membership are untouched, so a " +
          "partial list is safe. All-or-nothing: 400 if any lessonId is duplicated or isn't in this course, 404 " +
          "if the course doesn't exist. Never parses — needsReparse lists changed scripts on parsed lessons. " +
          "?dryRun=true previews without saving.",
        security: [{ apiKey: [] }],
        querystring: dryRunQuerystring,
        params: {
          type: "object",
          required: ["courseId"],
          properties: { courseId: { type: "string" } },
        },
        body: {
          type: "object",
          required: ["scripts"],
          additionalProperties: false,
          properties: {
            scripts: {
              type: "array",
              items: {
                type: "object",
                required: ["lessonId", "scriptText"],
                additionalProperties: false,
                properties: {
                  lessonId: { type: "string", minLength: 1 },
                  scriptText: { type: "string", minLength: 1 },
                },
              },
            },
          },
        },
      },
    },
    async (request, reply) => {
      const { courseId } = request.params as { courseId: string };
      const { dryRun } = request.query as { dryRun?: boolean };
      const { scripts } = request.body as { scripts: CourseScriptInput[] };
      try {
        return reply.send(await updateCourseScripts(app.db, courseId, scripts, { dryRun }));
      } catch (err) {
        if (err instanceof CourseScriptsError) {
          return reply
            .code(err.statusCode)
            .send({ error: err.statusCode === 404 ? "NotFound" : "BadRequest", message: err.message });
        }
        throw err;
      }
    }
  );

  app.post(
    "/courses/:courseId/scaffolding/translations/:targetLanguage",
    {
      preValidation: defaultEmptyBody,
      schema: {
        description:
          "Scaffolding command: translates the course name, section titles and lesson names + descriptions into " +
          "one language via DeepL (glossary + course outline as context), then Claude sanity-checks the results " +
          "and flags only clearly wrong items (never rewrites; DeepL's text is stored). mode: 'missing' (default — " +
          "never-translated or English-changed items only) or 'all'. A reviewer failure is reported in " +
          "review.error; translations are still saved. 400 for 'en', 404 unknown course, 502 if DeepL fails.",
        security: [{ apiKey: [] }],
        params: {
          type: "object",
          required: ["courseId", "targetLanguage"],
          properties: { courseId: { type: "string" }, targetLanguage: { type: "string" } },
        },
        body: {
          type: "object",
          additionalProperties: false,
          properties: { mode: { type: "string", enum: ["missing", "all"] } },
        },
      },
    },
    async (request, reply) => {
      const { courseId, targetLanguage } = request.params as { courseId: string; targetLanguage: string };
      const { mode } = (request.body ?? {}) as { mode?: ScaffoldingMode };
      try {
        return reply.send(
          await translateCourseScaffolding(
            {
              db: app.db,
              translationService: app.translationService,
              translationReviewer: app.translationReviewer,
            },
            courseId,
            targetLanguage,
            mode ?? "missing"
          )
        );
      } catch (err) {
        if (err instanceof TranslateScaffoldingError) {
          return reply
            .code(err.statusCode)
            .send({ error: err.statusCode === 404 ? "NotFound" : "BadRequest", message: err.message });
        }
        request.log.error(err, "Scaffolding translation failed");
        return reply.code(502).send({ error: "UpstreamError", message: err instanceof Error ? err.message : "Unknown error" });
      }
    }
  );

  app.put(
    "/courses/:courseId/scaffolding/translations/:targetLanguage",
    {
      schema: {
        description:
          "Hand corrections to a course's scaffolding in one language — course name, section titles, lesson " +
          "names/descriptions; every field optional. Stored as typed (no DeepL/Claude call), marked edited, " +
          "Claude's flag cleared. 'Re-translate all' keeps corrections; only a change to the English replaces " +
          "them. All-or-nothing. 400 bad/empty input or ids not in the course, 404 unknown course.",
        security: [{ apiKey: [] }],
        params: {
          type: "object",
          required: ["courseId", "targetLanguage"],
          properties: { courseId: { type: "string" }, targetLanguage: { type: "string" } },
        },
        body: {
          type: "object",
          additionalProperties: false,
          properties: {
            courseName: { type: "string" },
            courseDescription: { type: "string" },
            sections: {
              type: "array",
              items: {
                type: "object",
                additionalProperties: false,
                required: ["sectionId", "title"],
                properties: { sectionId: { type: "string", format: "uuid" }, title: { type: "string" } },
              },
            },
            lessons: {
              type: "array",
              items: {
                type: "object",
                additionalProperties: false,
                required: ["lessonId"],
                properties: { lessonId: { type: "string" }, lessonName: { type: "string" }, description: { type: "string" } },
              },
            },
          },
        },
      },
    },
    async (request, reply) => {
      const { courseId, targetLanguage } = request.params as { courseId: string; targetLanguage: string };
      try {
        return reply.send(await correctScaffolding(app.db, courseId, targetLanguage, request.body as ScaffoldingCorrections));
      } catch (err) {
        if (err instanceof TranslateScaffoldingError) {
          return reply
            .code(err.statusCode)
            .send({ error: err.statusCode === 404 ? "NotFound" : "BadRequest", message: err.message });
        }
        throw err;
      }
    }
  );

  app.post(
    "/courses/:courseId/translations/:targetLanguage",
    {
      preValidation: defaultEmptyBody,
      schema: {
        description:
          "Course-level translation job for one language: (1) gets the scripts ready — with proofread: true, " +
          "Claude typo-checks scripts not checked yet (mechanical fixes applied; the rest listed in " +
          "progress.review; a lesson that already has translations or audio is never changed) — and parses " +
          "lessons not parsed yet; (2) translates the scaffolding (course/section/lesson names, descriptions — " +
          "missing or stale); (3) translates the scripts, lesson by lesson. Async — 202 { jobId }; poll " +
          "GET /jobs/:jobId (progress: phase, total, succeeded, failed, skipped, stats, review, notes). Jobs of " +
          "one course queue behind each other ('pending'). mode 'missing' (default) only fills what's missing, so " +
          "re-running continues; 'all' re-translates every segment. Never generates audio. 409 (with the job) if " +
          "this course + language already has an active job; 400 for 'en'; 404 unknown course.",
        security: [{ apiKey: [] }],
        params: {
          type: "object",
          required: ["courseId", "targetLanguage"],
          properties: { courseId: { type: "string" }, targetLanguage: { type: "string" } },
        },
        body: {
          type: "object",
          additionalProperties: false,
          properties: { mode: { type: "string", enum: ["missing", "all"] }, proofread: { type: "boolean" } },
        },
      },
    },
    async (request, reply) => {
      const { courseId, targetLanguage } = request.params as { courseId: string; targetLanguage: string };
      const { mode, proofread } = (request.body ?? {}) as { mode?: CourseTranslationMode; proofread?: boolean };
      try {
        const job = await startCourseTranslationJob(
          {
            db: app.db,
            translationService: app.translationService,
            translationReviewer: app.translationReviewer,
            nlpService: app.nlpService,
            scriptProofreader: app.scriptProofreader,
          },
          courseId,
          targetLanguage,
          { mode: mode ?? "missing", proofread: !!proofread }
        );
        return reply.code(202).send({ jobId: job.id, job });
      } catch (err) {
        if (err instanceof JobConflictError) {
          return reply.code(409).send({ error: "Conflict", message: err.message, jobId: err.job.id, job: err.job });
        }
        if (err instanceof TranslateCourseError) {
          return reply
            .code(err.statusCode)
            .send({ error: err.statusCode === 404 ? "NotFound" : "BadRequest", message: err.message });
        }
        throw err;
      }
    }
  );

  app.post(
    "/courses/:courseId/localizations/:targetLanguage/generate",
    {
      preValidation: defaultEmptyBody,
      schema: {
        description:
          "Course-level audio job for one language ('en' included), into the course's Box folder: writes " +
          "'<Language> Segments.txt' per lesson (unchanged files skipped), then generates every missing clip " +
          "with the language's voice settings — <LANG>/<lessonId>/<Language> Clips/<lessonId>_<lang>_NNN.mp3. " +
          "Lessons not fully translated are skipped (never calls DeepL). Async — 202 { jobId }; poll " +
          "GET /jobs/:jobId (progress: succeeded, failed, skipped, stats { segmentFiles, clips, characters }). " +
          "Re-running continues where it stopped. 400 no Box folder / no voice for the language, 404 unknown " +
          "course, 409 (with the running job) if this course + language already has an active job.",
        security: [{ apiKey: [] }],
        params: {
          type: "object",
          required: ["courseId", "targetLanguage"],
          properties: { courseId: { type: "string" }, targetLanguage: { type: "string" } },
        },
        body: { type: "object", additionalProperties: false, properties: {} },
      },
    },
    async (request, reply) => {
      const { courseId, targetLanguage } = request.params as { courseId: string; targetLanguage: string };
      try {
        const job = await startCourseAudioJob(
          {
            db: app.db,
            translationService: app.translationService,
            ttsService: app.ttsService,
            qcService: app.qcService,
            fileStorageService: app.fileStorageService,
            voiceSettingsProvider: app.voiceSettingsProvider,
          },
          courseId,
          targetLanguage.toLowerCase()
        );
        return reply.code(202).send({ jobId: job.id, job });
      } catch (err) {
        if (err instanceof JobConflictError) {
          return reply.code(409).send({ error: "Conflict", message: err.message, jobId: err.job.id, job: err.job });
        }
        if (err instanceof CourseAudioJobError) {
          return reply.code(err.statusCode).send({ error: err.statusCode === 404 ? "NotFound" : "BadRequest", message: err.message });
        }
        if (err instanceof VoiceNotConfiguredError) return reply.code(400).send({ error: "BadRequest", message: err.message });
        throw err;
      }
    }
  );

  app.get(
    "/courses/:courseId/localizations/:targetLanguage/audit",
    {
      schema: {
        description:
          "Completeness audit of a course's audio in one language (also run at the end of every course audio job). " +
          "Per lesson: one Box-linked clip per segment in the database, and in Box the lesson folder, " +
          "'<Language> Segments.txt' and exactly clips 001…N, each the file the database points to. Warnings: gaps in " +
          "lesson numbering, extra files, lesson folders not in the course. Reads Box fresh; changes nothing. " +
          "Sync. 400 no Box folder, 404 unknown course.",
        security: [{ apiKey: [] }],
        params: {
          type: "object",
          required: ["courseId", "targetLanguage"],
          properties: { courseId: { type: "string" }, targetLanguage: { type: "string" } },
        },
      },
    },
    async (request, reply) => {
      const { courseId, targetLanguage } = request.params as { courseId: string; targetLanguage: string };
      try {
        return reply.send(await auditCourseAudio({ db: app.db, fileStorageService: app.fileStorageService }, courseId, targetLanguage.toLowerCase()));
      } catch (err) {
        if (err instanceof AuditError) {
          return reply.code(err.statusCode).send({ error: err.statusCode === 404 ? "NotFound" : "BadRequest", message: err.message });
        }
        throw err;
      }
    }
  );

  app.post(
    "/courses/:courseId/outputs/segments",
    {
      schema: {
        description:
          "Writes '<Language> Segments.txt' for every parsed lesson, per language, into the course folder " +
          "under LOCAL_OUTPUT_ROOT: <courseFolder>/<LANG>/<lessonId>/<Language> Segments.txt. 'en' = the " +
          "English segments. Numbered 001, 002… (matches future clip names). A translated file is only " +
          "written when every segment is translated — otherwise listed in skipped. courseFolder is relative " +
          "(default: the course name). Overwrites existing files. 400 if LOCAL_OUTPUT_ROOT isn't set.",
        security: [{ apiKey: [] }],
        params: { type: "object", required: ["courseId"], properties: { courseId: { type: "string" } } },
        body: {
          type: "object",
          required: ["languages"],
          additionalProperties: false,
          properties: {
            languages: { type: "array", minItems: 1, items: { type: "string", minLength: 2 } },
            courseFolder: { type: "string" },
          },
        },
      },
    },
    async (request, reply) => {
      const { courseId } = request.params as { courseId: string };
      const { languages, courseFolder } = request.body as { languages: string[]; courseFolder?: string };
      if (!app.lessonOutputStore) {
        return reply.code(400).send({ error: "BadRequest", message: "LOCAL_OUTPUT_ROOT is not set — no output folder configured" });
      }
      try {
        return reply.send(
          await writeCourseSegmentsFiles({ db: app.db, outputStore: app.lessonOutputStore }, courseId, { languages, courseFolder })
        );
      } catch (err) {
        if (err instanceof WriteSegmentsError) {
          return reply.code(err.statusCode).send({ error: err.statusCode === 404 ? "NotFound" : "BadRequest", message: err.message });
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
