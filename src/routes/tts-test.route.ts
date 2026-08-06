// src/routes/tts-test.route.ts
import type { FastifyInstance } from "fastify";
import type { VoiceSettings } from "../types/VoiceSettings.js";

const DEFAULT_OUTPUT_FORMAT = "mp3_44100_192";

interface TtsTestBody {
  text: string;
  voiceId: string;
  modelId: string;
  voiceSettings: VoiceSettings;
  previousText?: string;
  nextText?: string;
  seed?: number;
  previousRequestIds?: string[];
  outputFormat?: string;
}

export async function ttsTestRoute(app: FastifyInstance) {
  app.post(
    "/tts/test",
    {
      schema: {
        description:
          "Ad-hoc ElevenLabs synthesis for manual testing (voice/settings/continuity experiments). " +
          "Streams the raw audio back in the response instead of persisting anywhere — no Box upload, " +
          "no tts_clips row, no lesson/segment association. Not for pipeline use.",
        security: [{ apiKey: [] }],
        body: {
          type: "object",
          required: ["text", "voiceId", "modelId", "voiceSettings"],
          properties: {
            text: { type: "string" },
            voiceId: { type: "string" },
            modelId: { type: "string" },
            voiceSettings: {
              type: "object",
              required: ["stability", "similarityBoost"],
              properties: {
                stability: { type: "number" },
                similarityBoost: { type: "number" },
                style: { type: "number" },
                useSpeakerBoost: { type: "boolean" },
                speed: { type: "number" },
              },
            },
            previousText: { type: "string" },
            nextText: { type: "string" },
            seed: { type: "integer" },
            // Populate from the `requestId` returned by a prior call to this
            // endpoint to chain voice continuity. Empty/omitted on the first call.
            previousRequestIds: { type: "array", items: { type: "string" }, maxItems: 3 },
            outputFormat: { type: "string" },
          },
        },
      },
    },
    async (request, reply) => {
      const body = request.body as TtsTestBody;

      try {
        const result = await app.ttsService.synthesize({
          text: body.text,
          voiceId: body.voiceId,
          modelId: body.modelId,
          voiceSettings: body.voiceSettings,
          previousText: body.previousText,
          nextText: body.nextText,
          seed: body.seed,
          previousRequestIds: body.previousRequestIds,
          outputFormat: body.outputFormat ?? DEFAULT_OUTPUT_FORMAT,
        });

        return reply
          .header("content-type", result.contentType)
          .header("x-request-id", result.requestId)
          .send(result.audio);
      } catch (err) {
        request.log.error(err, "TTS test synthesis failed");
        return reply.code(502).send({
          error: "UpstreamError",
          message: err instanceof Error ? err.message : "Unknown error",
        });
      }
    }
  );
}
