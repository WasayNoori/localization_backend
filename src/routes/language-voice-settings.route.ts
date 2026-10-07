// src/routes/language-voice-settings.route.ts
import type { FastifyInstance } from "fastify";
import { asc, eq } from "drizzle-orm";
import { languageVoiceSettings, type VoiceSettingsSnapshot } from "../db/schema.js";
import { DEFAULT_TTS_MODEL, DEFAULT_VOICE_SETTINGS } from "../config/voice-defaults.js";

// Ranges ElevenLabs accepts. Speed outside 0.7–1.2 is rejected by the API.
const voiceSettingsSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    stability: { type: "number", minimum: 0, maximum: 1 },
    similarityBoost: { type: "number", minimum: 0, maximum: 1 },
    style: { type: "number", minimum: 0, maximum: 1 },
    speed: { type: "number", minimum: 0.7, maximum: 1.2 },
    useSpeakerBoost: { type: "boolean" },
  },
} as const;

export async function languageVoiceSettingsRoute(app: FastifyInstance) {
  // Plain CRUD against language_voice_settings — no service layer. Voice
  // config is per language, shared by every lesson (see docs/decisions.md).
  app.get(
    "/languages/voice-settings",
    {
      schema: {
        description:
          "Voice configuration of every configured language (one row per language: voiceId, modelId, " +
          "voiceSettings). A language that isn't listed has no voice — audio generation refuses it.",
        security: [{ apiKey: [] }],
      },
    },
    async () => app.db.select().from(languageVoiceSettings).orderBy(asc(languageVoiceSettings.targetLanguage))
  );

  app.put(
    "/languages/:targetLanguage/voice-settings",
    {
      schema: {
        description:
          "Sets the ElevenLabs voice for one language (shared by every lesson in that language). Fields " +
          "merge: anything omitted keeps its stored value (including individual voiceSettings keys). " +
          "Creating a language requires voiceId; modelId and voiceSettings then start from defaults " +
          "(eleven_multilingual_v2, stability 0.5, similarity 0.75). Ranges: stability/similarityBoost/" +
          "style 0–1, speed 0.7–1.2. Already generated clips keep the voice they were made with — " +
          "regenerate with force to apply a change.",
        security: [{ apiKey: [] }],
        params: { type: "object", required: ["targetLanguage"], properties: { targetLanguage: { type: "string", minLength: 2 } } },
        body: {
          type: "object",
          additionalProperties: false,
          properties: {
            voiceId: { type: "string", minLength: 1 },
            modelId: { type: "string", minLength: 1 },
            voiceSettings: voiceSettingsSchema,
          },
        },
      },
    },
    async (request, reply) => {
      const { targetLanguage } = request.params as { targetLanguage: string };
      const language = targetLanguage.toLowerCase();
      const body = request.body as { voiceId?: string; modelId?: string; voiceSettings?: Partial<VoiceSettingsSnapshot> };

      const [existing] = await app.db.select().from(languageVoiceSettings).where(eq(languageVoiceSettings.targetLanguage, language)).limit(1);
      if (!existing && !body.voiceId?.trim()) {
        return reply.code(400).send({ error: "BadRequest", message: `Pick a voice for "${language}" — voiceId is required the first time` });
      }

      const voiceId = body.voiceId?.trim() ?? existing!.voiceId;
      const modelId = body.modelId?.trim() ?? existing?.modelId ?? DEFAULT_TTS_MODEL;
      const voiceSettings: VoiceSettingsSnapshot = { ...(existing?.voiceSettings ?? DEFAULT_VOICE_SETTINGS), ...body.voiceSettings };

      const [saved] = await app.db
        .insert(languageVoiceSettings)
        .values({ targetLanguage: language, voiceId, modelId, voiceSettings })
        .onConflictDoUpdate({ target: languageVoiceSettings.targetLanguage, set: { voiceId, modelId, voiceSettings, updatedAt: new Date() } })
        .returning();
      return reply.send(saved);
    }
  );
}
