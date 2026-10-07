// src/routes/language-translation-settings.route.ts
import type { FastifyInstance } from "fastify";
import { asc } from "drizzle-orm";
import { languageTranslationSettings } from "../db/schema.js";
import { FORMALITY_VALUES } from "../interfaces/ITranslationService.js";

export async function languageTranslationSettingsRoute(app: FastifyInstance) {
  // Plain CRUD against language_translation_settings — no service layer.
  app.get(
    "/languages/translation-settings",
    {
      schema: {
        description: "DeepL settings per target language (formality). A language that isn't listed uses DeepL's defaults.",
        security: [{ apiKey: [] }],
      },
    },
    async () => app.db.select().from(languageTranslationSettings).orderBy(asc(languageTranslationSettings.targetLanguage))
  );

  app.put(
    "/languages/:targetLanguage/translation-settings",
    {
      schema: {
        description:
          "Sets formal vs informal 'you' for one language, sent with every DeepL request for it: more = formal " +
          "(usted/vous/Sie), less = informal (tú/tu/du), prefer_* = same but silently ignored by languages " +
          "without formality, default = DeepL decides per sentence. Existing translations made under a different " +
          "formality become stale: the course translation's 'missing' mode re-translates them (their audio " +
          "then needs regenerating).",
        security: [{ apiKey: [] }],
        params: { type: "object", required: ["targetLanguage"], properties: { targetLanguage: { type: "string", minLength: 2 } } },
        body: {
          type: "object",
          required: ["formality"],
          additionalProperties: false,
          properties: { formality: { type: "string", enum: [...FORMALITY_VALUES] } },
        },
      },
    },
    async (request) => {
      const language = (request.params as { targetLanguage: string }).targetLanguage.toLowerCase();
      const { formality } = request.body as { formality: string };
      const [row] = await app.db
        .insert(languageTranslationSettings)
        .values({ targetLanguage: language, formality })
        .onConflictDoUpdate({ target: languageTranslationSettings.targetLanguage, set: { formality, updatedAt: new Date() } })
        .returning();
      return row;
    }
  );
}
