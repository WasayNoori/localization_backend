// src/routes/segments.route.ts
import type { FastifyInstance } from "fastify";
import { retranslateSegment } from "../services/translation/retranslateSegment.js";

export async function segmentsRoute(app: FastifyInstance) {
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
          { db: app.db, translationService: app.translationService },
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
