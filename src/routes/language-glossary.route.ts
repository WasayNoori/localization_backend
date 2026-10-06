// src/routes/language-glossary.route.ts
import type { FastifyInstance } from "fastify";
import { upsertGlossary } from "../services/glossaries/upsertGlossary.js";
import { syncGlossariesFromProvider } from "../services/glossaries/syncGlossariesFromProvider.js";

export async function languageGlossaryRoute(app: FastifyInstance) {
  // Plain upsert against glossaries (shared with POST /glossaries/sync).
  // One glossary
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

      const saved = await upsertGlossary(app.db, targetLanguage, deeplGlossaryId);

      return reply.send(saved);
    }
  );

  app.post(
    "/glossaries/sync",
    {
      schema: {
        description:
          "Points the glossaries table at the account's current DeepL glossaries: for each target language, " +
          "the newest ready English→X glossary. Run after uploading a glossary (DeepL can't update one in " +
          "place, so each upload is a new id). ?dryRun=true reports without writing. Never deletes rows; " +
          "languages with no DeepL glossary are listed in notInProvider. 502 if DeepL fails. Same as " +
          "`npm run glossaries:sync`.",
        security: [{ apiKey: [] }],
        querystring: { type: "object", properties: { dryRun: { type: "boolean" } } },
      },
    },
    async (request, reply) => {
      const { dryRun } = request.query as { dryRun?: boolean };
      try {
        return reply.send(
          await syncGlossariesFromProvider({ db: app.db, translationService: app.translationService }, { dryRun })
        );
      } catch (err) {
        request.log.error(err, "Glossary sync failed");
        return reply.code(502).send({ error: "UpstreamError", message: err instanceof Error ? err.message : "Unknown error" });
      }
    }
  );
}
