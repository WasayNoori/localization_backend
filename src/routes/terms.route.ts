// src/routes/terms.route.ts
// Ambiguous terms (kept out of the DeepL glossaries) and the sense decided per segment.
import type { FastifyInstance, FastifyReply } from "fastify";
import { checkLessonTerms } from "../services/terms/checkLessonTerms.js";
import { listLessonTermDecisions, setSegmentTermDecision, TermDecisionError } from "../services/terms/segmentTermDecisions.js";
import { deleteTerm, listTerms, saveTerm, TermCatalogError, type SaveTermInput } from "../services/terms/termCatalog.js";

const termBody = {
  type: "object",
  required: ["term", "senses"],
  additionalProperties: false,
  properties: {
    term: { type: "string", minLength: 1 },
    note: { type: ["string", "null"] },
    active: { type: "boolean" },
    senses: {
      type: "array",
      minItems: 2,
      items: {
        type: "object",
        required: ["meaning"],
        additionalProperties: false,
        properties: {
          id: { type: "string" },
          meaning: { type: "string", minLength: 1 },
          translations: { type: "object", additionalProperties: { type: "string" } },
        },
      },
    },
  },
} as const;

function sendError(reply: FastifyReply, err: unknown) {
  if (err instanceof TermCatalogError || err instanceof TermDecisionError) {
    const error = err.statusCode === 404 ? "NotFound" : err.statusCode === 409 ? "Conflict" : "BadRequest";
    return reply.code(err.statusCode).send({ error, message: err.message });
  }
  throw err;
}

export async function termsRoute(app: FastifyInstance) {
  app.get(
    "/terms",
    {
      schema: {
        description:
          "Ambiguous terms: common English words kept out of the DeepL glossaries because their translation " +
          "depends on the sentence. Each has senses (meaning + translation per language) and segmentCount " +
          "(segments with a decision). Before translation, Claude picks the sense per segment; DeepL then gets " +
          "a custom instruction for it.",
        tags: ["terms"],
        security: [{ apiKey: [] }],
      },
    },
    async (_request, reply) => reply.send(await listTerms(app.db))
  );

  app.post(
    "/terms",
    {
      schema: {
        description:
          "Adds an ambiguous term with at least two senses: { term, note?, active?, senses: [{ meaning, " +
          "translations: { fr: …, es: … } }] }. 409 if the term exists (case-insensitive). Remove the word from " +
          "the DeepL glossaries too, or the glossary keeps forcing one meaning.",
        tags: ["terms"],
        security: [{ apiKey: [] }],
        body: termBody,
      },
    },
    async (request, reply) => {
      try {
        return reply.code(201).send(await saveTerm(app.db, request.body as SaveTermInput));
      } catch (err) {
        return sendError(reply, err);
      }
    }
  );

  app.put(
    "/terms/:termId",
    {
      schema: {
        description:
          "Replaces a term and its senses (senses with an id are updated, without one added, missing ones " +
          "deleted with their decisions). Rewording the term or a sense, or adding one, clears Claude's " +
          "decisions so segments are checked again; a person's decisions stay. Translation-only edits keep " +
          "decisions — the affected translations become stale and the next course translation redoes them.",
        tags: ["terms"],
        security: [{ apiKey: [] }],
        params: { type: "object", required: ["termId"], properties: { termId: { type: "string", format: "uuid" } } },
        body: termBody,
      },
    },
    async (request, reply) => {
      const { termId } = request.params as { termId: string };
      try {
        return reply.send(await saveTerm(app.db, request.body as SaveTermInput, termId));
      } catch (err) {
        return sendError(reply, err);
      }
    }
  );

  app.delete(
    "/terms/:termId",
    {
      schema: {
        description: "Deletes a term with its senses and decisions. Translations made with its instructions become stale.",
        tags: ["terms"],
        security: [{ apiKey: [] }],
        params: { type: "object", required: ["termId"], properties: { termId: { type: "string", format: "uuid" } } },
      },
    },
    async (request, reply) => {
      const { termId } = request.params as { termId: string };
      try {
        await deleteTerm(app.db, termId);
        return reply.code(204).send();
      } catch (err) {
        return sendError(reply, err);
      }
    }
  );

  app.get(
    "/lessons/:lessonId/terms",
    {
      schema: {
        description:
          "Every active ambiguous term found in the lesson's segments, with the decided sense: outcome " +
          "sense | other (a meaning not listed — DeepL decides) | unclear (flagged — DeepL decides) | " +
          "unchecked (no decision yet), decidedBy claude | person.",
        tags: ["terms"],
        security: [{ apiKey: [] }],
        params: { type: "object", required: ["lessonId"], properties: { lessonId: { type: "string" } } },
      },
    },
    async (request, reply) => {
      const { lessonId } = request.params as { lessonId: string };
      try {
        return reply.send(await listLessonTermDecisions(app.db, lessonId));
      } catch (err) {
        return sendError(reply, err);
      }
    }
  );

  app.post(
    "/lessons/:lessonId/terms/check",
    {
      schema: {
        description:
          "Runs the ambiguous-term check now (translation runs it too): Claude decides the sense for segments " +
          "without a decision. { recheck: true } asks again for Claude's earlier decisions as well (never a " +
          "person's). Sync. Returns { segmentsWithTerms, asked, outcomes, error }.",
        tags: ["terms"],
        security: [{ apiKey: [] }],
        params: { type: "object", required: ["lessonId"], properties: { lessonId: { type: "string" } } },
        body: { type: "object", additionalProperties: false, properties: { recheck: { type: "boolean" } } },
      },
      preValidation: async (request) => {
        if (request.body === undefined || request.body === null) request.body = {};
      },
    },
    async (request, reply) => {
      const { lessonId } = request.params as { lessonId: string };
      const { recheck } = request.body as { recheck?: boolean };
      try {
        await listLessonTermDecisions(app.db, lessonId); // 404 for an unknown lesson
        return reply.send(await checkLessonTerms({ db: app.db, termSenseResolver: app.termSenseResolver }, lessonId, { recheck }));
      } catch (err) {
        return sendError(reply, err);
      }
    }
  );

  app.put(
    "/segments/:segmentId/terms/:termId",
    {
      schema: {
        description:
          "A person's decision for one segment + term: { outcome: sense | other | unclear, senseId (for " +
          "sense), note? }. Kept over Claude's re-checks. The segment's translations become stale where the " +
          "instruction changes — re-translate the segment, or the next course translation redoes them.",
        tags: ["terms"],
        security: [{ apiKey: [] }],
        params: {
          type: "object",
          required: ["segmentId", "termId"],
          properties: { segmentId: { type: "string", format: "uuid" }, termId: { type: "string", format: "uuid" } },
        },
        body: {
          type: "object",
          required: ["outcome"],
          additionalProperties: false,
          properties: {
            outcome: { type: "string", enum: ["sense", "other", "unclear"] },
            senseId: { type: ["string", "null"] },
            note: { type: ["string", "null"] },
          },
        },
      },
    },
    async (request, reply) => {
      const { segmentId, termId } = request.params as { segmentId: string; termId: string };
      try {
        await setSegmentTermDecision(app.db, segmentId, termId, request.body as { outcome: "sense" | "other" | "unclear"; senseId?: string | null; note?: string | null });
        return reply.code(204).send();
      } catch (err) {
        return sendError(reply, err);
      }
    }
  );
}
