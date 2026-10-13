// src/services/terms/termCatalog.ts
// Ambiguous terms and their senses: list, save (create or replace), delete.
import { and, asc, eq, inArray, ne, sql } from "drizzle-orm";
import type { Database } from "../../db/client.js";
import { ambiguousTermSenses, ambiguousTerms, segmentTermSenses } from "../../db/schema.js";

export class TermCatalogError extends Error {
  constructor(
    message: string,
    readonly statusCode: 400 | 404 | 409
  ) {
    super(message);
  }
}

export interface TermSense {
  id: string;
  meaning: string;
  /** Translation per target language (lowercase code → text). */
  translations: Record<string, string>;
}

export interface AmbiguousTerm {
  id: string;
  term: string;
  note: string | null;
  active: boolean;
  senses: TermSense[];
  /** Segments with a decision for this term (any outcome). */
  segmentCount: number;
  updatedAt: string;
}

export interface SaveTermInput {
  term: string;
  note?: string | null;
  active?: boolean;
  /** The full list: senses with an id are updated, without one are added, missing ones are deleted. */
  senses: { id?: string; meaning: string; translations?: Record<string, string> }[];
}

export async function listTerms(db: Database, options: { activeOnly?: boolean } = {}): Promise<AmbiguousTerm[]> {
  const terms = await db
    .select()
    .from(ambiguousTerms)
    .where(options.activeOnly ? eq(ambiguousTerms.active, true) : undefined)
    .orderBy(asc(sql`lower(${ambiguousTerms.term})`));
  if (!terms.length) return [];
  const ids = terms.map((t) => t.id);
  const [senses, counts] = await Promise.all([
    db
      .select()
      .from(ambiguousTermSenses)
      .where(inArray(ambiguousTermSenses.termId, ids))
      .orderBy(asc(ambiguousTermSenses.position), asc(ambiguousTermSenses.createdAt)),
    db
      .select({ termId: segmentTermSenses.termId, n: sql<number>`count(*)::int` })
      .from(segmentTermSenses)
      .where(inArray(segmentTermSenses.termId, ids))
      .groupBy(segmentTermSenses.termId),
  ]);
  const countOf = new Map(counts.map((c) => [c.termId, Number(c.n)]));
  return terms.map((t) => ({
    id: t.id,
    term: t.term,
    note: t.note,
    active: t.active,
    senses: senses
      .filter((s) => s.termId === t.id)
      .map((s) => ({ id: s.id, meaning: s.meaning, translations: s.translations })),
    segmentCount: countOf.get(t.id) ?? 0,
    updatedAt: t.updatedAt.toISOString(),
  }));
}

export async function getTerm(db: Database, termId: string): Promise<AmbiguousTerm | null> {
  return (await listTerms(db)).find((t) => t.id === termId) ?? null;
}

/**
 * Creates (no termId) or replaces a term with its senses, in one transaction.
 * Changing the term's wording, or adding/rewording a sense, clears Claude's
 * decisions for it so every segment is checked again; a person's decisions are
 * kept unless their sense was deleted. Translation-only edits keep every
 * decision — the affected translations become stale and are redone by the
 * next course translation.
 */
export async function saveTerm(db: Database, input: SaveTermInput, termId?: string): Promise<AmbiguousTerm> {
  const term = input.term?.trim();
  if (!term) throw new TermCatalogError("term is required", 400);
  if (term.length > 80) throw new TermCatalogError("term is longer than 80 characters", 400);
  const senses = input.senses.map((s, position) => ({
    id: s.id,
    meaning: s.meaning?.trim() ?? "",
    translations: cleanTranslations(s.translations ?? {}),
    position,
  }));
  if (senses.some((s) => !s.meaning)) throw new TermCatalogError("every sense needs a meaning", 400);
  if (senses.length < 2) throw new TermCatalogError("a term needs at least two senses — otherwise it belongs in the glossary", 400);

  const id = await db.transaction(async (tx) => {
    const clash = await tx
      .select({ id: ambiguousTerms.id })
      .from(ambiguousTerms)
      .where(and(sql`lower(${ambiguousTerms.term}) = lower(${term})`, termId ? ne(ambiguousTerms.id, termId) : undefined))
      .limit(1);
    if (clash.length) throw new TermCatalogError(`"${term}" is already an ambiguous term`, 409);

    let id = termId;
    let recheck = false;
    if (!id) {
      const [row] = await tx.insert(ambiguousTerms).values({ term, note: input.note ?? null, active: input.active ?? true }).returning();
      id = row.id;
    } else {
      const [existing] = await tx.select().from(ambiguousTerms).where(eq(ambiguousTerms.id, id)).limit(1);
      if (!existing) throw new TermCatalogError(`No ambiguous term with id "${id}"`, 404);
      recheck = existing.term.toLowerCase() !== term.toLowerCase();
      await tx
        .update(ambiguousTerms)
        .set({ term, note: input.note ?? null, active: input.active ?? existing.active, updatedAt: new Date() })
        .where(eq(ambiguousTerms.id, id));
    }

    const current = await tx.select().from(ambiguousTermSenses).where(eq(ambiguousTermSenses.termId, id));
    const unknown = senses.filter((s) => s.id && !current.some((c) => c.id === s.id));
    if (unknown.length) throw new TermCatalogError(`Senses not on this term: ${unknown.map((s) => s.id).join(", ")}`, 400);
    const keep = new Set(senses.filter((s) => s.id).map((s) => s.id!));
    const removed = current.filter((c) => !keep.has(c.id)).map((c) => c.id);
    // Deleting a sense deletes the decisions that chose it (FK cascade).
    if (removed.length) await tx.delete(ambiguousTermSenses).where(inArray(ambiguousTermSenses.id, removed));
    for (const s of senses) {
      if (s.id) {
        const before = current.find((c) => c.id === s.id)!;
        if (before.meaning !== s.meaning) recheck = true;
        await tx
          .update(ambiguousTermSenses)
          .set({ meaning: s.meaning, translations: s.translations, position: s.position, updatedAt: new Date() })
          .where(eq(ambiguousTermSenses.id, s.id));
      } else {
        if (termId) recheck = true;
        await tx.insert(ambiguousTermSenses).values({ termId: id, meaning: s.meaning, translations: s.translations, position: s.position });
      }
    }
    if (recheck) {
      await tx.delete(segmentTermSenses).where(and(eq(segmentTermSenses.termId, id), eq(segmentTermSenses.decidedBy, "claude")));
    }
    return id;
  });
  return (await getTerm(db, id))!;
}

export async function deleteTerm(db: Database, termId: string): Promise<void> {
  const deleted = await db.delete(ambiguousTerms).where(eq(ambiguousTerms.id, termId)).returning({ id: ambiguousTerms.id });
  if (!deleted.length) throw new TermCatalogError(`No ambiguous term with id "${termId}"`, 404);
}

function cleanTranslations(input: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [lang, text] of Object.entries(input)) {
    const code = lang.trim().toLowerCase();
    const value = typeof text === "string" ? text.trim() : "";
    if (!/^[a-z]{2}(-[a-z]{2})?$/.test(code)) throw new TermCatalogError(`Not a language code: "${lang}"`, 400);
    if (value) out[code] = value;
  }
  return out;
}
