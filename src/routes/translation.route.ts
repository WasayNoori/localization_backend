// src/routes/translation.route.ts
import type { FastifyInstance } from "fastify";

export async function translationRoute(app: FastifyInstance) {
  app.post(
    "/translate",
    {
      schema: {
        security: [{ apiKey: [] }],
        body: {
          type: "object",
          required: ["text", "targetLanguage"],
          properties: {
            text: { type: "string" },
            targetLanguage: { type: "string" },
            glossaryId: { type: "string" },
            context: { type: "string" },
          },
        },
      },
    },
    async (request, reply) => {
      const { text, targetLanguage, glossaryId, context } = request.body as {
        text: string;
        targetLanguage: string;
        glossaryId?: string;
        context?: string;
      };

      if (!text || !targetLanguage) {
        return reply.code(400).send({ error: "text and targetLanguage are required" });
      }

      try {
        const result = await app.translationService.translate({
          text,
          targetLanguage,
          glossaryId,
          context,
        });

        return reply.send(result);
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
