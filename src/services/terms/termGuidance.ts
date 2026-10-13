// src/services/terms/termGuidance.ts
// Turns stored sense decisions into DeepL custom instructions, per segment and language.
import { and, asc, eq, inArray } from "drizzle-orm";
import type { Database } from "../../db/client.js";
import { ambiguousTermSenses, ambiguousTerms, segmentTermSenses } from "../../db/schema.js";

const MAX_INSTRUCTIONS = 10;
const MAX_LENGTH = 300;

/** e.g. "Tab" here means a tab of a dialog box or PropertyManager; translate it as "onglet". */
export function termInstruction(term: string, meaning: string, translation: string): string {
  const text = `"${term}" here means ${meaning}; translate it as "${translation}".`;
  return text.length <= MAX_LENGTH ? text : `"${term}": translate it as "${translation}" (${meaning})`.slice(0, MAX_LENGTH);
}

/**
 * The instructions each segment should be translated with in one language:
 * one per active term whose decided sense has a translation in that language.
 * Segments with none are absent from the map.
 */
export async function getTermGuidance(db: Database, segmentIds: string[], language: string): Promise<Map<string, string[]>> {
  const result = new Map<string, string[]>();
  if (!segmentIds.length) return result;
  const rows = await db
    .select({
      segmentId: segmentTermSenses.segmentId,
      term: ambiguousTerms.term,
      meaning: ambiguousTermSenses.meaning,
      translations: ambiguousTermSenses.translations,
    })
    .from(segmentTermSenses)
    .innerJoin(ambiguousTerms, eq(ambiguousTerms.id, segmentTermSenses.termId))
    .innerJoin(ambiguousTermSenses, eq(ambiguousTermSenses.id, segmentTermSenses.senseId))
    .where(
      and(
        inArray(segmentTermSenses.segmentId, segmentIds),
        eq(segmentTermSenses.outcome, "sense"),
        eq(ambiguousTerms.active, true)
      )
    )
    .orderBy(asc(ambiguousTerms.term));
  for (const r of rows) {
    const translation = r.translations[language];
    if (!translation) continue;
    const list = result.get(r.segmentId) ?? [];
    if (list.length < MAX_INSTRUCTIONS) list.push(termInstruction(r.term, r.meaning, translation));
    result.set(r.segmentId, list);
  }
  return result;
}

/** Whether a stored translation was made with exactly the guidance it should get now (null ≡ none). */
export function sameGuidance(stored: string[] | null, expected: string[] | undefined): boolean {
  const a = stored ?? [];
  const b = expected ?? [];
  return a.length === b.length && a.every((x, i) => x === b[i]);
}
