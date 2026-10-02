// src/routes/lessons.route.ts
import type { FastifyInstance } from "fastify";
import { eq } from "drizzle-orm";
import { lessons } from "../db/schema.js";
import { generateLocalizationForLesson } from "../services/generation/generateLocalizationForLesson.js";
import { parseLessonSegments } from "../services/parsing/parseLessonSegments.js";
import { translateLessonSegments, TranslateLessonError } from "../services/translation/translateLessonSegments.js";

export async function lessonsRoute(app: FastifyInstance) {
  // Plain CRUD against `lessons` — no service/interface layer, same pattern
  // as jobs.route.ts, since there's no external system involved here, just
  // an insert. `id` is caller-assigned (never rekeyed — see
  // docs/decisions.md), so this is also how you register a lesson whose
  // English script is already sitting in Box before parsing it.
  app.post(
    "/lessons",
    {
      schema: {
        description:
          "Registers a lesson — plain CRUD insert, no service layer. id is caller-assigned and never " +
          "rekeyed. Typically called once the lesson's English script is already uploaded to Box and you " +
          "have the boxFileId, before calling POST /lessons/:lessonId/parse. 409 if id already exists.",
        security: [{ apiKey: [] }],
        body: {
          type: "object",
          required: ["id", "lessonName"],
          properties: {
            id: { type: "string" },
            lessonName: { type: "string" },
            boxFileId: { type: "string" },
          },
        },
      },
    },
    async (request, reply) => {
      const { id, lessonName, boxFileId } = request.body as {
        id: string;
        lessonName: string;
        boxFileId?: string;
      };

      const [existing] = await app.db.select().from(lessons).where(eq(lessons.id, id)).limit(1);
      if (existing) {
        return reply.code(409).send({ error: "Conflict", message: `Lesson "${id}" already exists` });
      }

      const [created] = await app.db
        .insert(lessons)
        .values({ id, lessonName, boxFileId: boxFileId ?? null })
        .returning();

      return reply.code(201).send(created);
    }
  );

  app.post(
    "/lessons/:lessonId/parse",
    {
      schema: {
        description:
          "Parses a lesson's English script (lessons.script_text, falling back to Box via boxFileId) into lesson_segments via " +
          "spaCy — one transaction, rewriting all segments for the lesson. Re-parsing is destructive: it " +
          "cascades to delete existing segment_translations/tts_clips for this lesson across every " +
          "language. Requires scriptText (POST /courses/import) or boxFileId to be set.",
        security: [{ apiKey: [] }],
        params: {
          type: "object",
          required: ["lessonId"],
          properties: {
            lessonId: { type: "string" },
          },
        },
      },
    },
    async (request, reply) => {
      const { lessonId } = request.params as { lessonId: string };

      try {
        const result = await parseLessonSegments(
          {
            db: app.db,
            fileStorageService: app.fileStorageService,
            nlpService: app.nlpService,
          },
          lessonId
        );

        return reply.send(result);
      } catch (err) {
        request.log.error(err, "Lesson parse failed");
        return reply.code(500).send({
          error: "InternalError",
          message: err instanceof Error ? err.message : "Unknown error",
        });
      }
    }
  );

  app.post(
    "/lessons/:lessonId/translations/:targetLanguage",
    {
      schema: {
        description:
          "Translates every segment of the lesson (or only segmentIds) via DeepL with the full lesson script " +
          "as context, overwriting existing translations. Text only — never touches audio; audioStale lists " +
          "segments whose current audio no longer matches the new text (regenerate via the generate endpoint " +
          "with segmentId + force). Sync, per-segment: failures land in errors[]. 400 if the lesson doesn't " +
          "exist, has no segments, segmentIds aren't in it, or targetLanguage is 'en'.",
        security: [{ apiKey: [] }],
        params: {
          type: "object",
          required: ["lessonId", "targetLanguage"],
          properties: {
            lessonId: { type: "string" },
            targetLanguage: { type: "string" },
          },
        },
        body: {
          type: "object",
          additionalProperties: false,
          properties: {
            segmentIds: { type: "array", items: { type: "string" }, minItems: 1 },
          },
        },
      },
    },
    async (request, reply) => {
      const { lessonId, targetLanguage } = request.params as { lessonId: string; targetLanguage: string };
      const { segmentIds } = (request.body ?? {}) as { segmentIds?: string[] };

      try {
        const result = await translateLessonSegments(
          { db: app.db, translationService: app.translationService },
          lessonId,
          targetLanguage,
          { segmentIds }
        );
        return reply.send(result);
      } catch (err) {
        if (err instanceof TranslateLessonError) {
          return reply.code(400).send({ error: "BadRequest", message: err.message });
        }
        request.log.error(err, "Lesson translation failed");
        return reply.code(500).send({
          error: "InternalError",
          message: err instanceof Error ? err.message : "Unknown error",
        });
      }
    }
  );

  app.post(
    "/lessons/:lessonId/localizations/:targetLanguage/generate",
    {
      schema: {
        description:
          "Resumable 'find what's missing' generate loop for one lesson + target language: translates " +
          "(DeepL, reusing any existing segment_translations row) and synthesizes audio (ElevenLabs) for " +
          "every segment lacking an active tts_clips row, uploads to Box, and records the clip. " +
          "Non-transactional per segment — one segment's failure is caught into errors[] rather than " +
          "aborting the rest, and re-calling this picks up exactly what's still missing. Requires the " +
          "lesson to already be parsed. To retranslate a single segment without paying for audio " +
          "regeneration, use POST /segments/:segmentId/translations/:targetLanguage/retranslate instead, " +
          "then call this with segmentId + force once satisfied.",
        security: [{ apiKey: [] }],
        params: {
          type: "object",
          required: ["lessonId", "targetLanguage"],
          properties: {
            lessonId: { type: "string" },
            targetLanguage: { type: "string" },
          },
        },
        body: {
          type: "object",
          required: ["boxFolderId"],
          properties: {
            boxFolderId: { type: "string" },
            // Optional: restrict this call to one segment, for manual
            // single-segment regeneration/debugging rather than the normal
            // find-what's-missing sweep over the whole lesson.
            segmentId: { type: "string" },
            // Optional: verify each already-"active" clip's Box file still
            // exists, superseding + regenerating any that don't. Off by
            // default — see GenerateLocalizationOptions for why.
            verifyBoxFiles: { type: "boolean" },
            // Optional: regenerate every segment for this lesson+language
            // regardless of current state. Takes priority over verifyBoxFiles.
            force: { type: "boolean" },
          },
        },
      },
    },
    async (request, reply) => {
      const { lessonId, targetLanguage } = request.params as {
        lessonId: string;
        targetLanguage: string;
      };
      const { boxFolderId, segmentId, verifyBoxFiles, force } = request.body as {
        boxFolderId: string;
        segmentId?: string;
        verifyBoxFiles?: boolean;
        force?: boolean;
      };

      try {
        const result = await generateLocalizationForLesson(
          {
            db: app.db,
            translationService: app.translationService,
            ttsService: app.ttsService,
            qcService: app.qcService,
            fileStorageService: app.fileStorageService,
            voiceSettingsProvider: app.voiceSettingsProvider,
            boxFolderId,
          },
          lessonId,
          targetLanguage,
          { segmentId, verifyBoxFiles, force }
        );

        return reply.send(result);
      } catch (err) {
        request.log.error(err, "Localization generation failed");
        return reply.code(500).send({
          error: "InternalError",
          message: err instanceof Error ? err.message : "Unknown error",
        });
      }
    }
  );
}
