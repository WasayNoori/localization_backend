// src/services/proofreading/applyScriptCorrections.ts
import type { ScriptCorrection } from "../../interfaces/IScriptProofreader.js";

export interface ProofreadOutcome {
  text: string;
  /** Applied automatically — small, mechanical fixes. */
  applied: ScriptCorrection[];
  /** Not applied: a person should decide (the proofreader said so, or the change is too big to be a typo). */
  review: (ScriptCorrection & { why: string })[];
  /** Not applied: `original` isn't in the script exactly once. */
  skipped: (ScriptCorrection & { why: string })[];
}

/**
 * Applies only corrections that are clearly mechanical, whatever the
 * proofreader's confidence: punctuation/spacing, a misspelling (≤2 letters
 * off), up to two short inserted words, or removing a doubled / one short
 * word — and never a change to a number. Everything else goes to `review`.
 * Pure: no I/O.
 */
export function applyScriptCorrections(text: string, corrections: ScriptCorrection[]): ProofreadOutcome {
  const out: ProofreadOutcome = { text, applied: [], review: [], skipped: [] };
  for (const c of corrections) {
    if (c.original === c.corrected) continue;
    const count = out.text.split(c.original).length - 1;
    if (count !== 1) {
      out.skipped.push({ ...c, why: count === 0 ? "not found exactly in the script" : `found ${count} times` });
      continue;
    }
    if (c.needsReview) {
      out.review.push({ ...c, why: "proofreader asked for review" });
      continue;
    }
    const tooBig = whyNotMechanical(c.original, c.corrected);
    if (tooBig) {
      out.review.push({ ...c, why: tooBig });
      continue;
    }
    out.text = out.text.replace(c.original, () => c.corrected);
    out.applied.push(c);
  }
  return out;
}

const words = (s: string) => (s.match(/[\p{L}\d]+(?:['’][\p{L}]+)*/gu) ?? []).map((w) => w.toLowerCase());

/** Null when the edit is mechanical; otherwise why it needs a person. */
export function whyNotMechanical(original: string, corrected: string): string | null {
  const a = words(original);
  const b = words(corrected);
  const digits = (ws: string[]) => ws.filter((w) => /\d/.test(w)).join(" ");
  if (digits(a) !== digits(b)) return "changes a number";

  const ops = alignWords(a, b);
  const subs = ops.filter((o) => o.op === "sub");
  const ins = ops.filter((o) => o.op === "ins");
  const dels = ops.filter((o) => o.op === "del");
  if (subs.length + ins.length + dels.length > 4) return "too many word changes";
  for (const s of subs) {
    if (!smallWordFix(s.from!, s.to!)) return `replaces "${s.from}" with "${s.to}"`;
  }
  if (ins.length > 2 || ins.some((i) => i.to!.length > 5)) return "adds more than a couple of short words";
  // Deleting a doubled word or phrase ("the end of the end of") is mechanical;
  // otherwise at most two short words ("I'll add right-click" -> "I'll right-click").
  const deleted = new Set(doubledRuns(a, dels.map((d) => d.index)));
  const other = dels.filter((d) => !deleted.has(d.index));
  if (other.length > 2 || other.some((d) => d.from!.length > 4)) return "deletes words";
  return null;
}

/**
 * A misspelling (≤2 letters off), an inflection (select→selecting, stress→stresses),
 * two words run together (thenthe→then, SOLIDWORKSSOLIDWORKS→SOLIDWORKS), or one short
 * function word for another (of→over). Not: pounds→kg.
 */
function smallWordFix(from: string, to: string): boolean {
  if (levenshtein(from, to) <= 2) return true;
  const [long, short] = from.length >= to.length ? [from, to] : [to, from];
  if (long.startsWith(short) && long.length - short.length <= 3) return true; // inflection / merged short word
  if (from === to + to) return true; // word typed twice without a space
  return from.length <= 4 && to.length <= 4;
}

/** Indexes (in `a`) of deleted runs that repeat the words right before or after them. */
function doubledRuns(a: string[], deletedIdx: number[]): number[] {
  const runs: number[][] = [];
  for (const i of [...deletedIdx].sort((x, y) => x - y)) {
    const last = runs.at(-1);
    if (last && last.at(-1) === i - 1) last.push(i);
    else runs.push([i]);
  }
  const same = (x: number, y: number, n: number) => x >= 0 && y + n <= a.length && a.slice(x, x + n).join(" ") === a.slice(y, y + n).join(" ");
  return runs.filter((r) => same(r[0] - r.length, r[0], r.length) || same(r[0] + r.length, r[0], r.length)).flat();
}

type Op = { op: "eq" | "sub" | "ins" | "del"; from?: string; to?: string; index: number };

/** Word-level edit-distance alignment (case-insensitive words). */
function alignWords(a: string[], b: string[]): Op[] {
  const d = Array.from({ length: a.length + 1 }, (_, i) => Array.from({ length: b.length + 1 }, (_, j) => (i === 0 ? j : j === 0 ? i : 0)));
  for (let i = 1; i <= a.length; i++)
    for (let j = 1; j <= b.length; j++)
      d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
  const ops: Op[] = [];
  let i = a.length;
  let j = b.length;
  while (i > 0 || j > 0) {
    if (i > 0 && j > 0 && d[i][j] === d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1)) {
      ops.push({ op: a[i - 1] === b[j - 1] ? "eq" : "sub", from: a[i - 1], to: b[j - 1], index: i - 1 });
      i--;
      j--;
    } else if (i > 0 && d[i][j] === d[i - 1][j] + 1) {
      ops.push({ op: "del", from: a[i - 1], index: i - 1 });
      i--;
    } else {
      ops.push({ op: "ins", to: b[j - 1], index: i });
      j--;
    }
  }
  return ops.reverse();
}

function levenshtein(x: string, y: string): number {
  const row = Array.from({ length: y.length + 1 }, (_, j) => j);
  for (let i = 1; i <= x.length; i++) {
    let prev = row[0];
    row[0] = i;
    for (let j = 1; j <= y.length; j++) {
      const tmp = row[j];
      row[j] = Math.min(row[j] + 1, row[j - 1] + 1, prev + (x[i - 1] === y[j - 1] ? 0 : 1));
      prev = tmp;
    }
  }
  return row[y.length];
}
