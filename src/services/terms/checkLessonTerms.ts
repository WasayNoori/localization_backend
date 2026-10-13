// src/services/terms/checkLessonTerms.ts
import { and, asc, eq, inArray } from "drizzle-orm";
import type { Database } from "../../db/client.js";
import { courseLessons, courses, lessonSegments, lessons, segmentTermSenses } from "../../db/schema.js";
import type { ITermSenseResolver, TermSenseQuestion } from "../../interfaces/ITermSenseResolver.js";
import { listTerms, type AmbiguousTerm } from "./termCatalog.js";
import { findTerms } from "./termMatcher.js";

export interface CheckTermsDeps {
  db: Database;
  termSenseResolver: ITermSenseResolver;
}

export interface CheckTermsResult {
  lessonId: string;
  /** Segments containing at least one active ambiguous term. */
  segmentsWithTerms: number;
  /** Segment × term pairs sent to Claude this time (0 when everything was already decided). */
  asked: number;
  /** Current decisions for the lesson, by outcome (all of them, not just this run's). */
  outcomes: { sense: number; other: number; unclear: number };
  /** Claude failed: nothing new decided; translation goes ahead without the missing instructions. */
  error: string | null;
}

/**
 * Language-independent step before translation: for each segment containing
 * an active ambiguous term that has no decision yet, Claude picks the sense
 * (one call per lesson, batched). Decisions are stored in segment_term_senses
 * and reused for every language. `recheck` asks again for Claude's earlier
 * decisions too; a person's decision is never overwritten. Decisions for terms
 * no longer in a segment's text are removed.
 */
export async function checkLessonTerms(
  deps: CheckTermsDeps,
  lessonId: string,
  options: { recheck?: boolean; terms?: AmbiguousTerm[] } = {}
): Promise<CheckTermsResult> {
  const { db } = deps;
  const result: CheckTermsResult = { lessonId, segmentsWithTerms: 0, asked: 0, outcomes: { sense: 0, other: 0, unclear: 0 }, error: null };

  const terms = (options.terms ?? (await listTerms(db, { activeOnly: true }))).filter((t) => t.active && t.senses.length >= 2);
  const segments = await db
    .select({ id: lessonSegments.id, text: lessonSegments.text })
    .from(lessonSegments)
    .where(eq(lessonSegments.lessonId, lessonId))
    .orderBy(asc(lessonSegments.sequenceIndex));
  if (!segments.length) return result;

  const existing = await db.select().from(segmentTermSenses).where(inArray(segmentTermSenses.segmentId, segments.map((s) => s.id)));
  const decision = (segmentId: string, termId: string) => existing.find((d) => d.segmentId === segmentId && d.termId === termId);

  const questions: (TermSenseQuestion & { segmentId: string; termId: string })[] = [];
  const stale: { segmentId: string; termId: string }[] = [];
  for (const [index, segment] of segments.entries()) {
    const found = findTerms(segment.text, terms);
    if (found.length) result.segmentsWithTerms++;
    for (const d of existing.filter((d) => d.segmentId === segment.id)) {
      if (terms.some((t) => t.id === d.termId) && !found.some((t) => t.id === d.termId)) stale.push(d);
    }
    for (const term of found) {
      const d = decision(segment.id, term.id);
      if (d && (d.decidedBy === "person" || !options.recheck)) continue;
      questions.push({
        key: `${segment.id}:${term.id}`,
        segmentId: segment.id,
        termId: term.id,
        term: term.term,
        segmentText: segment.text,
        previousText: index > 0 ? segments[index - 1].text.slice(-300) : "",
        senses: term.senses.map((s) => ({ senseId: s.id, meaning: s.meaning })),
      });
    }
  }

  for (const s of stale) {
    await db.delete(segmentTermSenses).where(and(eq(segmentTermSenses.segmentId, s.segmentId), eq(segmentTermSenses.termId, s.termId)));
  }

  if (questions.length) {
    result.asked = questions.length;
    try {
      const answers = await deps.termSenseResolver.resolve({ context: await lessonContext(db, lessonId), questions });
      const byKey = new Map(questions.map((q) => [q.key, q]));
      for (const a of answers) {
        const q = byKey.get(a.key)!;
        const values = { senseId: a.senseId, outcome: a.outcome, decidedBy: "claude", note: a.note, decidedAt: new Date() };
        await db
          .insert(segmentTermSenses)
          .values({ segmentId: q.segmentId, termId: q.termId, ...values })
          .onConflictDoUpdate({ target: [segmentTermSenses.segmentId, segmentTermSenses.termId], set: values });
      }
    } catch (err) {
      result.error = err instanceof Error ? err.message : String(err);
    }
  }

  const current = await db
    .select({ outcome: segmentTermSenses.outcome })
    .from(segmentTermSenses)
    .where(inArray(segmentTermSenses.segmentId, segments.map((s) => s.id)));
  for (const c of current) {
    if (c.outcome === "sense" || c.outcome === "other" || c.outcome === "unclear") result.outcomes[c.outcome]++;
  }
  return result;
}

/** "Course: …; Lesson: …" — which subject the narration is about. */
async function lessonContext(db: Database, lessonId: string): Promise<string> {
  const [lesson] = await db.select({ name: lessons.lessonName }).from(lessons).where(eq(lessons.id, lessonId)).limit(1);
  const courseRows = await db
    .select({ name: courses.courseName })
    .from(courseLessons)
    .innerJoin(courses, eq(courses.id, courseLessons.courseId))
    .where(eq(courseLessons.lessonId, lessonId));
  return [
    courseRows.length ? `Course: ${courseRows.map((c) => c.name).join("; ")}` : null,
    `Lesson: ${lesson?.name ?? lessonId}`,
  ]
    .filter(Boolean)
    .join("\n");
}
