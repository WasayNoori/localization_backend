// src/services/terms/segmentTermDecisions.ts
// Read a lesson's ambiguous-term decisions; set one by hand.
import { and, asc, eq, inArray } from "drizzle-orm";
import type { Database } from "../../db/client.js";
import { ambiguousTermSenses, ambiguousTerms, lessonSegments, lessons, segmentTermSenses } from "../../db/schema.js";
import { listTerms } from "./termCatalog.js";
import { findTerms } from "./termMatcher.js";

export class TermDecisionError extends Error {
  constructor(
    message: string,
    readonly statusCode: 400 | 404
  ) {
    super(message);
  }
}

export type TermOutcome = "sense" | "other" | "unclear";

export interface SegmentTermDecision {
  segmentId: string;
  /** 1-based, as shown in the console. */
  segmentNumber: number;
  termId: string;
  term: string;
  /** "unchecked" = the term is in the segment but no decision exists yet. */
  outcome: TermOutcome | "unchecked";
  senseId: string | null;
  meaning: string | null;
  decidedBy: "claude" | "person" | null;
  note: string | null;
  decidedAt: string | null;
}

/** Every active ambiguous term found in the lesson's segments, with its decision (or "unchecked"). */
export async function listLessonTermDecisions(db: Database, lessonId: string): Promise<SegmentTermDecision[]> {
  const [lesson] = await db.select({ id: lessons.id }).from(lessons).where(eq(lessons.id, lessonId)).limit(1);
  if (!lesson) throw new TermDecisionError(`No lesson with id "${lessonId}"`, 404);
  const segments = await db
    .select({ id: lessonSegments.id, index: lessonSegments.sequenceIndex, text: lessonSegments.text })
    .from(lessonSegments)
    .where(eq(lessonSegments.lessonId, lessonId))
    .orderBy(asc(lessonSegments.sequenceIndex));
  if (!segments.length) return [];
  const terms = (await listTerms(db, { activeOnly: true })).filter((t) => t.senses.length >= 2);
  const decisions = await db
    .select({ d: segmentTermSenses, meaning: ambiguousTermSenses.meaning })
    .from(segmentTermSenses)
    .leftJoin(ambiguousTermSenses, eq(ambiguousTermSenses.id, segmentTermSenses.senseId))
    .where(inArray(segmentTermSenses.segmentId, segments.map((s) => s.id)));

  const out: SegmentTermDecision[] = [];
  for (const s of segments) {
    for (const t of findTerms(s.text, terms)) {
      const found = decisions.find((r) => r.d.segmentId === s.id && r.d.termId === t.id);
      out.push({
        segmentId: s.id,
        segmentNumber: s.index + 1,
        termId: t.id,
        term: t.term,
        outcome: (found?.d.outcome as TermOutcome | undefined) ?? "unchecked",
        senseId: found?.d.senseId ?? null,
        meaning: found?.meaning ?? null,
        decidedBy: (found?.d.decidedBy as "claude" | "person" | undefined) ?? null,
        note: found?.d.note ?? null,
        decidedAt: found?.d.decidedAt.toISOString() ?? null,
      });
    }
  }
  return out;
}

/**
 * A person's decision for one segment + term. Kept over Claude's re-checks.
 * The segment's translations whose instructions change become stale and are
 * redone by the next course translation (or re-translate the segment).
 */
export async function setSegmentTermDecision(
  db: Database,
  segmentId: string,
  termId: string,
  input: { outcome: TermOutcome; senseId?: string | null; note?: string | null }
): Promise<void> {
  const [segment] = await db.select({ id: lessonSegments.id }).from(lessonSegments).where(eq(lessonSegments.id, segmentId)).limit(1);
  if (!segment) throw new TermDecisionError(`No segment with id "${segmentId}"`, 404);
  const [term] = await db.select({ id: ambiguousTerms.id }).from(ambiguousTerms).where(eq(ambiguousTerms.id, termId)).limit(1);
  if (!term) throw new TermDecisionError(`No ambiguous term with id "${termId}"`, 404);
  let senseId: string | null = null;
  if (input.outcome === "sense") {
    if (!input.senseId) throw new TermDecisionError(`outcome "sense" needs a senseId`, 400);
    const [sense] = await db
      .select({ id: ambiguousTermSenses.id })
      .from(ambiguousTermSenses)
      .where(and(eq(ambiguousTermSenses.id, input.senseId), eq(ambiguousTermSenses.termId, termId)))
      .limit(1);
    if (!sense) throw new TermDecisionError(`Sense "${input.senseId}" is not a sense of this term`, 400);
    senseId = sense.id;
  }
  const values = { senseId, outcome: input.outcome, decidedBy: "person", note: input.note?.trim() || null, decidedAt: new Date() };
  await db
    .insert(segmentTermSenses)
    .values({ segmentId, termId, ...values })
    .onConflictDoUpdate({ target: [segmentTermSenses.segmentId, segmentTermSenses.termId], set: values });
}
