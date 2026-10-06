// src/routes/translation.route.ts
import type { FastifyInstance } from "fastify";
import { translateTexts } from "../services/translation/translateTexts.js";

export async function translationRoute(app: FastifyInstance) {
  app.post(
    "/translate",
    {
      schema: {
        description:
          "Stateless DeepL passthrough — translates the given text and returns the result directly. " +
          "Automatically applies this target language's glossary (looked up from the glossaries table via " +
          "PUT /languages/:targetLanguage/glossary) if one is configured — no glossaryId to pass in. " +
          "Writes nothing to the database (no segment_translations row); unrelated to the lesson-level " +
          "generate flow, which persists translations as part of resolving a lesson's segments.",
        security: [{ apiKey: [] }],
        body: {
          type: "object",
          required: ["text", "targetLanguage"],
          properties: {
            text: { type: "string" },
            targetLanguage: { type: "string" },
            context: { type: "string" },
          },
        },
      },
    },
    async (request, reply) => {
      const { text, targetLanguage, context } = request.body as {
        text: string;
        targetLanguage: string;
        context?: string;
      };

      if (!text || !targetLanguage) {
        return reply.code(400).send({ error: "text and targetLanguage are required" });
      }

      try {
        const {
          translatedTexts: [translatedText],
        } = await translateTexts(
          { db: app.db, translationService: app.translationService },
          { texts: [text], targetLanguage, context }
        );

        return reply.send({ translatedText });
      } catch (err) {
        request.log.error(err, "Translation failed");
        return reply.code(502).send({
          error: "UpstreamError",
          message: err instanceof Error ? err.message : "Unknown error",
        });
      }
    }
  );
}
