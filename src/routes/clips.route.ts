// src/routes/clips.route.ts
import type { FastifyInstance } from "fastify";
import { eq } from "drizzle-orm";
import { ttsClips } from "../db/schema.js";

// mp3_44100_192 → audio/mpeg, pcm_* → audio/wav-ish raw; only formats we generate.
function contentTypeFor(audioFormat: string): string {
  if (audioFormat.startsWith("mp3")) return "audio/mpeg";
  if (audioFormat.startsWith("opus")) return "audio/ogg";
  return "application/octet-stream";
}

export async function clipsRoute(app: FastifyInstance) {
  // Streams a clip's audio from Box through the API, so browsers never need
  // Box credentials or shared links. Thin route: one lookup + one Box read.
  app.get(
    "/clips/:clipId/audio",
    {
      schema: {
        description:
          "Returns a tts_clips row's audio bytes, read from Box via IFileStorageService. Content-Type from the " +
          "clip's audio_format. 404 if the clip doesn't exist or has no Box file.",
        security: [{ apiKey: [] }],
        params: {
          type: "object",
          required: ["clipId"],
          properties: { clipId: { type: "string", format: "uuid" } },
        },
      },
    },
    async (request, reply) => {
      const { clipId } = request.params as { clipId: string };
      const [clip] = await app.db.select().from(ttsClips).where(eq(ttsClips.id, clipId)).limit(1);
      if (!clip?.boxFileId) {
        return reply.code(404).send({ error: "NotFound", message: `No audio for clip "${clipId}"` });
      }
      try {
        const audio = await app.fileStorageService.getFileContent(clip.boxFileId);
        return reply.type(contentTypeFor(clip.audioFormat)).header("cache-control", "private, max-age=3600").send(audio);
      } catch (err) {
        request.log.error(err, "Clip audio fetch failed");
        return reply.code(502).send({ error: "UpstreamError", message: err instanceof Error ? err.message : "Unknown error" });
      }
    }
  );
}
