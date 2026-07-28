// src/routes/tts.route.ts
import type { FastifyInstance } from "fastify";

export async function ttsRoute(app: FastifyInstance) {
  app.post(
    "/tts/synthesize",
    {
      schema: {
        description:
          "One-off ElevenLabs synthesis using the current IVoiceSettingsProvider defaults, then uploads " +
          "the result to the given Box folder. Not tied to any lesson/segment — writes nothing to " +
          "tts_clips or any other table. For lesson-scoped generation that persists into tts_clips, use " +
          "POST /lessons/:lessonId/localizations/:targetLanguage/generate instead.",
        security: [{ apiKey: [] }],
        body: {
          type: "object",
          required: ["text", "folderId"],
          properties: {
            text: { type: "string" },
            fileName: { type: "string" },
            folderId: { type: "string" },
          },
        },
      },
    },
    async (request, reply) => {
      const { text, fileName, folderId } = request.body as {
        text: string;
        fileName?: string;
        folderId: string;
      };

      if (!text) {
        return reply.code(400).send({ error: "text is required" });
      }

      try {
        const settings = await app.voiceSettingsProvider.getSettings();

        const result = await app.ttsService.synthesize({
          text,
          ...settings,
        });

        const saved = await app.fileStorageService.saveAudio(result.audio, fileName ?? result.requestId, folderId);

        return reply.send({ requestId: result.requestId, fileId: saved.fileId, filePath: saved.filePath });
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