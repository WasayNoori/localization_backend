// src/routes/language-glossary.route.ts
import type { FastifyInstance } from "fastify";
import { eq } from "drizzle-orm";
import { glossaries } from "../db/schema.js";

export async function languageGlossaryRoute(app: FastifyInstance) {
  // Plain CRUD upsert against glossaries — no service/interface layer, same
  // pattern as PUT /languages/:targetLanguage/voice-settings. One glossary
  // per target language, independent of voice configuration (see
  // docs/decisions.md) — DeepL manages the glossary's actual contents, this
  // just stores the id mapping.
  app.put(
    "/languages/:targetLanguage/glossary",
    {
      schema: {
        description:
          "Upserts the DeepL glossary id for one target language. One glossary per language, looked up " +
          "by target_language when translating (see translateAndStoreSegment) — not scoped to a lesson or " +
          "segment. DeepL manages the glossary's actual contents; this just stores the id mapping. " +
          "Deliberately a separate endpoint from PUT /languages/:targetLanguage/voice-settings — glossary " +
          "(translation QC) and voice settings (ElevenLabs tuning) are independent concerns.",
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
          required: ["deeplGlossaryId"],
          properties: {
            deeplGlossaryId: { type: "string" },
          },
        },
      },
    },
    async (request, reply) => {
      const { targetLanguage } = request.params as { targetLanguage: string };
      const { deeplGlossaryId } = request.body as { deeplGlossaryId: string };

      const [existing] = await app.db
        .select()
        .from(glossaries)
        .where(eq(glossaries.targetLanguage, targetLanguage))
        .limit(1);

      const [saved] = existing
        ? await app.db
            .update(glossaries)
            .set({ deeplGlossaryId, updatedAt: new Date() })
            .where(eq(glossaries.targetLanguage, targetLanguage))
            .returning()
        : await app.db
            .insert(glossaries)
            .values({ targetLanguage, deeplGlossaryId })
            .returning();

      return reply.send(saved);
    }
  );
}
