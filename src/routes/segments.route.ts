// src/routes/segments.route.ts
import type { FastifyInstance } from "fastify";
import { retranslateSegment } from "../services/translation/retranslateSegment.js";
import {
  overrideSegmentTranslation,
  OverrideSegmentTranslationError,
} from "../services/translation/overrideSegmentTranslation.js";

export async function segmentsRoute(app: FastifyInstance) {
  app.put(
    "/segments/:segmentId/translations/:targetLanguage",
    {
      schema: {
        description:
          "Hand override of a segment's translation — stores translatedText as-is (no DeepL call), clears " +
          "length_warning so audio can be generated, and marks the row edited so the course translation " +
          "leaves it alone. Send DeepL's existing text back to accept it as is. Does not touch tts_clips; " +
          "regenerate audio with POST /lessons/:lessonId/localizations/:targetLanguage/generate (segmentId + force).",
        security: [{ apiKey: [] }],
        params: {
          type: "object",
          required: ["segmentId", "targetLanguage"],
          properties: {
            segmentId: { type: "string" },
            targetLanguage: { type: "string" },
          },
        },
        body: {
          type: "object",
          required: ["translatedText"],
          properties: { translatedText: { type: "string", minLength: 1 } },
        },
      },
    },
    async (request, reply) => {
      const { segmentId, targetLanguage } = request.params as { segmentId: string; targetLanguage: string };
      const { translatedText } = request.body as { translatedText: string };
      try {
        return reply.send(await overrideSegmentTranslation(app.db, segmentId, targetLanguage, translatedText));
      } catch (err) {
        if (err instanceof OverrideSegmentTranslationError) {
          return reply.code(err.statusCode).send({ error: err.statusCode === 404 ? "NotFound" : "BadRequest", message: err.message });
        }
        request.log.error(err, "Segment translation override failed");
        return reply.code(500).send({ error: "InternalError", message: err instanceof Error ? err.message : "Unknown error" });
      }
    }
  );

  app.post(
    "/segments/:segmentId/translations/:targetLanguage/retranslate",
    {
      schema: {
        description:
          "Discards the existing segment_translations row for this segment+language and re-translates via " +
          "DeepL. Deliberately decoupled from audio generation — does not touch tts_clips, so QC on a " +
          "translation can iterate without paying for ElevenLabs on every retry. Once satisfied, call " +
          "POST /lessons/:lessonId/localizations/:targetLanguage/generate with segmentId + force to " +
          "regenerate audio from the new translation.",
        security: [{ apiKey: [] }],
        params: {
          type: "object",
          required: ["segmentId", "targetLanguage"],
          properties: {
            segmentId: { type: "string" },
            targetLanguage: { type: "string" },
          },
        },
      },
    },
    async (request, reply) => {
      const { segmentId, targetLanguage } = request.params as {
        segmentId: string;
        targetLanguage: string;
      };

      try {
        const result = await retranslateSegment(
          { db: app.db, translationService: app.translationService, termSenseResolver: app.termSenseResolver },
          segmentId,
          targetLanguage
        );

        return reply.send(result);
      } catch (err) {
        request.log.error(err, "Segment retranslation failed");
        return reply.code(500).send({
          error: "InternalError",
          message: err instanceof Error ? err.message : "Unknown error",
        });
      }
    }
  );
}
