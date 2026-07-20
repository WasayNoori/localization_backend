// src/routes/lessons.route.ts
import type { FastifyInstance } from "fastify";
import { generateLocalizationForLesson } from "../services/generation/generateLocalizationForLesson.js";

export async function lessonsRoute(app: FastifyInstance) {
  app.post(
    "/lessons/:lessonId/localizations/:targetLanguage/generate",
    {
      schema: {
        security: [{ apiKey: [] }],
        params: {
          type: "object",
          required: ["lessonId", "targetLanguage"],
          properties: {
            lessonId: { type: "string" },
            targetLanguage: { type: "string" },
          },
        },
      },
    },
    async (request, reply) => {
      const { lessonId, targetLanguage } = request.params as {
        lessonId: string;
        targetLanguage: string;
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
          },
          lessonId,
          targetLanguage
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
