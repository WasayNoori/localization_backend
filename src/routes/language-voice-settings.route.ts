// src/routes/language-voice-settings.route.ts
import type { FastifyInstance } from "fastify";
import { eq } from "drizzle-orm";
import { languageVoiceSettings, type VoiceSettingsSnapshot } from "../db/schema.js";

export async function languageVoiceSettingsRoute(app: FastifyInstance) {
  // Plain CRUD upsert against language_voice_settings — no service/interface
  // layer, same pattern as POST /lessons. Voice config is per-language, not
  // per-lesson (see docs/decisions.md), so this has no lessonId at all.
  //
  // Every field is optional and partial: anything you specify overwrites
  // just that value (including individual keys inside voiceSettings, e.g.
  // sending only { stability } leaves style/speed/etc. untouched); anything
  // you omit keeps its current value, or falls back to
  // IVoiceSettingsProvider's defaults if this language has no row yet.
  app.put(
    "/languages/:targetLanguage/voice-settings",
    {
      schema: {
        description:
          "Upserts voice configuration (voiceId/modelId/voiceSettings) for one target language — shared by " +
          "every lesson generating in that language, not scoped to a lesson. Every field is optional and " +
          "merges rather than replaces (including individual voiceSettings keys, e.g. sending only " +
          "{ stability } leaves style/speed/etc. untouched); omitted fields keep their current value, or " +
          "fall back to IVoiceSettingsProvider defaults if the language has no row yet. To pick up a " +
          "changed voice on an already-generated lesson, call this first, then " +
          "POST /lessons/:lessonId/localizations/:targetLanguage/generate with force: true.",
        security: [{ apiKey: [] }],
        params: {
          type: "object",
          required: ["targetLanguage"],
          properties: {
            targetLanguage: { type: "string" },
          },
        },
        body: {
          type: "object",
          properties: {
            voiceId: { type: "string" },
            modelId: { type: "string" },
            voiceSettings: {
              type: "object",
              properties: {
                stability: { type: "number" },
                similarityBoost: { type: "number" },
                style: { type: "number" },
                speed: { type: "number" },
                useSpeakerBoost: { type: "boolean" },
              },
            },
          },
        },
      },
    },
    async (request, reply) => {
      const { targetLanguage } = request.params as { targetLanguage: string };
      const body = request.body as {
        voiceId?: string;
        modelId?: string;
        voiceSettings?: Partial<VoiceSettingsSnapshot>;
      };

      const [existing] = await app.db
        .select()
        .from(languageVoiceSettings)
        .where(eq(languageVoiceSettings.targetLanguage, targetLanguage))
        .limit(1);

      const base = existing
        ? { voiceId: existing.voiceId, modelId: existing.modelId, voiceSettings: existing.voiceSettings }
        : await app.voiceSettingsProvider.getSettings();

      const voiceId = body.voiceId ?? base.voiceId;
      const modelId = body.modelId ?? base.modelId;
      const voiceSettings: VoiceSettingsSnapshot = { ...base.voiceSettings, ...body.voiceSettings };

      const [saved] = existing
        ? await app.db
            .update(languageVoiceSettings)
            .set({ voiceId, modelId, voiceSettings, updatedAt: new Date() })
            .where(eq(languageVoiceSettings.targetLanguage, targetLanguage))
            .returning()
        : await app.db
            .insert(languageVoiceSettings)
            .values({ targetLanguage, voiceId, modelId, voiceSettings })
            .returning();

      return reply.send(saved);
    }
  );
}
