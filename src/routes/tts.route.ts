// src/routes/tts.route.ts
import type { FastifyInstance } from "fastify";
import { VoiceNotConfiguredError } from "../interfaces/IvoiceSettingsProvider.js";

export async function ttsRoute(app: FastifyInstance) {
  app.post(
    "/tts/synthesize",
    {
      schema: {
        description:
          "One-off ElevenLabs synthesis with a language's configured voice (language, default 'en'), then uploads " +
          "the result to the given Box folder. Not tied to any lesson/segment — writes nothing to " +
          "tts_clips or any other table. For lesson-scoped generation that persists into tts_clips, use " +
          "POST /lessons/:lessonId/localizations/:targetLanguage/generate instead.",
        security: [{ apiKey: [] }],
        body: {
          type: "object",
          required: ["text", "folderId"],
          properties: {
            text: { type: "string" },
            language: { type: "string" },
            fileName: { type: "string" },
            folderId: { type: "string" },
          },
        },
      },
    },
    async (request, reply) => {
      const { text, fileName, folderId, language } = request.body as {
        text: string;
        language?: string;
        fileName?: string;
        folderId: string;
      };

      if (!text) {
        return reply.code(400).send({ error: "text is required" });
      }

      try {
        const { voiceId, modelId, voiceSettings } = await app.voiceSettingsProvider.getSettings(language ?? "en");

        const result = await app.ttsService.synthesize({ text, voiceId, modelId, voiceSettings });

        const saved = await app.fileStorageService.saveAudio(result.audio, fileName ?? result.requestId, folderId);

        return reply.send({ requestId: result.requestId, fileId: saved.fileId, filePath: saved.filePath });
      } catch (err) {
        if (err instanceof VoiceNotConfiguredError) return reply.code(400).send({ error: "BadRequest", message: err.message });
        request.log.error(err, "TTS synthesis failed");
        return reply.code(502).send({
          error: "UpstreamError",
          message: err instanceof Error ? err.message : "Unknown error",
        });
      }
    }
  );

  app.get(
    "/tts/options",
    {
      schema: {
        description:
          "What the ElevenLabs account offers, for the voice Settings page: voices (id, name, category, " +
          "labels such as accent/gender) and text-to-speech models (id, name, supported languages). 502 if " +
          "ElevenLabs can't be reached.",
        security: [{ apiKey: [] }],
      },
    },
    async (request, reply) => {
      try {
        const [voices, models] = await Promise.all([app.ttsService.listVoices(), app.ttsService.listModels()]);
        return reply.send({ voices, models });
      } catch (err) {
        request.log.error(err, "ElevenLabs options failed");
        return reply.code(502).send({ error: "UpstreamError", message: err instanceof Error ? err.message : "Unknown error" });
      }
    }
  );
}
