// src/routes/tts.route.ts
import type { FastifyInstance } from "fastify";

export async function ttsRoute(app: FastifyInstance) {
  app.post(
    "/tts/synthesize",
    {
      schema: {
        security: [{ apiKey: [] }],
        body: {
          type: "object",
          required: ["text"],
          properties: {
            text: { type: "string" },
          },
        },
      },
    },
    async (request, reply) => {
      const { text } = request.body as { text: string };

      if (!text) {
        return reply.code(400).send({ error: "text is required" });
      }

      try {
        const settings = await app.voiceSettingsProvider.getSettings();

        const result = await app.ttsService.synthesize({
          text,
          ...settings,
        });

        const saved = await app.fileStorageService.saveAudio(result.audio, result.requestId);

        return reply.send({ requestId: result.requestId, filePath: saved.filePath });
      } catch (err) {
        request.log.error(err, "TTS synthesis failed");
        return reply.code(502).send({
          error: "UpstreamError",
          message: err instanceof Error ? err.message : "Unknown error",
        });
      }
    }
  );
}