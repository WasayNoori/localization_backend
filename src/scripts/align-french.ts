// Pure alignment logic (no I/O, no DB, no DeepL).
//
// Goal: for ONE lesson, produce exactly one French segment per English DB segment,
// built only from the French sentence file. The legacy English sentence file is the
// bridge: sentence N in the English file is the translation source of sentence N in
// the French file, so we group the English sentences to best match each DB segment
// and reuse the same groups for French.
//
// Matching is deliberately loose (word-overlap, stopwords ignored): small wording
// differences are fine, and a sentence missing from either side is tolerated.

export interface NumberedSentence {
  number: number;
  text: string;
}

export interface EnglishSegment {
  id: string;
  sequenceIndex: number;
  text: string;
}

export type SegmentStatus = "ok" | "low" | "missing";

export interface AlignedSegment {
  segmentId: string;
  sequenceIndex: number;
  firstSentence: number; // 1-based, 0 when missing
  lastSentence: number; // 1-based, 0 when missing
  englishText: string;
  frenchText: string; // "" when missing
  similarity: number; // 0..1, 0 when missing
  status: SegmentStatus;
}

export interface AlignOptions {
  /** A group scoring below this is treated as "no counterpart" (segment left empty). */
  matchFloor: number;
  /** Cost of dropping a sentence that no segment wants (extra sentence in the files). */
  skipPenalty: number;
  /** Segments with similarity below this are flagged "low" for review. */
  warnBelow: number;
  /** Whole lesson is rejected if the mean segment similarity is below this (wrong script). */
  minLessonScore: number;
  maxSentencesPerSegment: number;
}

export const DEFAULT_OPTIONS: AlignOptions = {
  matchFloor: 0.35,
  skipPenalty: 0.2,
  warnBelow: 0.8,
  minLessonScore: 0.6,
  maxSentencesPerSegment: 12,
};

export type AlignResult =
  | {
      ok: true;
      segments: AlignedSegment[]; // always one entry per English segment, same order
      droppedSentences: number[]; // sentence numbers used by no segment
      lessonScore: number; // mean similarity, missing counts as 0
      warnings: string[];
    }
  | { ok: false; reason: string };

/** Parses "N. text" lines. Lines without a number continue the previous sentence. */
export function parseNumberedScript(raw: string): { sentences: NumberedSentence[]; warnings: string[] } {
  const sentences: NumberedSentence[] = [];
  const warnings: string[] = [];
  const lines = raw.replace(/^﻿/, "").split(/\r?\n/);
  lines.forEach((line, i) => {
    const trimmed = line.trim();
    if (!trimmed) return;
    const m = /^(\d+)\.\s+(.*)$/.exec(trimmed);
    if (m) {
      sentences.push({ number: Number(m[1]), text: m[2].trim() });
    } else if (sentences.length > 0) {
      sentences[sentences.length - 1].text += " " + trimmed;
      warnings.push(`line ${i + 1}: no sentence number, appended to sentence ${sentences[sentences.length - 1].number}`);
    } else {
      // Known defect in some legacy files: the first sentence lost its "1." (left as ". text" or bare text).
      sentences.push({ number: 1, text: trimmed.replace(/^\.\s*/, "") });
      warnings.push(`line ${i + 1}: first sentence had no valid number, treated as sentence 1`);
    }
  });
  sentences.forEach((s, idx) => {
    if (s.number !== idx + 1) warnings.push(`sentence numbering is not sequential at position ${idx + 1} (found ${s.number})`);
  });
  return { sentences, warnings };
}

const STOPWORDS = new Set(
  "the a an and or of to in on for is are be will i you we it this that with as at by s ll m can your my me if so but also just".split(" "),
);

const tokens = (s: string): string[] => {
  const all = s
    .toLowerCase()
    .replace(/[‘’]/g, "'")
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim()
    .split(" ")
    .filter(Boolean);
  const content = all.filter((t) => !STOPWORDS.has(t));
  return content.length > 0 ? content : all; // very short segments: keep everything
};

/** Dice coefficient over content-word bags; tolerant of small edits. */
export function similarity(a: string, b: string): number {
  const ta = tokens(a);
  const tb = tokens(b);
  if (ta.length === 0 || tb.length === 0) return 0;
  const counts = new Map<string, number>();
  ta.forEach((t) => counts.set(t, (counts.get(t) ?? 0) + 1));
  let overlap = 0;
  for (const t of tb) {
    const c = counts.get(t) ?? 0;
    if (c > 0) {
      overlap++;
      counts.set(t, c - 1);
    }
  }
  return (2 * overlap) / (ta.length + tb.length);
}

type Step = { kind: "take"; count: number } | { kind: "skip" };

/**
 * Monotone alignment: walk the sentences in order; each segment takes k >= 0 consecutive
 * sentences (k = 0 means "no counterpart"), and a sentence may be dropped at a penalty.
 * Maximises total similarity. Exactly one output entry per segment, always.
 */
export function alignSegments(
  segments: EnglishSegment[],
  english: NumberedSentence[],
  french: NumberedSentence[],
  options: AlignOptions = DEFAULT_OPTIONS,
): AlignResult {
  if (english.length !== french.length) {
    return { ok: false, reason: `sentence count differs: English ${english.length}, French ${french.length}` };
  }
  if (segments.length === 0) return { ok: false, reason: "no English segments" };

  const segs = [...segments].sort((a, b) => a.sequenceIndex - b.sequenceIndex);
  const m = segs.length;
  const n = english.length;
  const NEG = -Infinity;

  const dp: number[][] = Array.from({ length: m + 1 }, () => new Array<number>(n + 1).fill(NEG));
  const back: (Step | null)[][] = Array.from({ length: m + 1 }, () => new Array<Step | null>(n + 1).fill(null));
  dp[0][0] = 0;

  // Similarity of segment i against english[j .. j+k), memoised.
  const simCache = new Map<number, number>();
  const groupSim = (i: number, j: number, k: number): number => {
    const key = (i * (n + 1) + j) * (options.maxSentencesPerSegment + 1) + k;
    let v = simCache.get(key);
    if (v === undefined) {
      v = similarity(segs[i].text, english.slice(j, j + k).map((s) => s.text).join(" "));
      simCache.set(key, v);
    }
    return v;
  };

  for (let i = 0; i <= m; i++) {
    for (let j = 0; j <= n; j++) {
      const cur = dp[i][j];
      if (cur === NEG) continue;
      if (j < n && cur - options.skipPenalty > dp[i][j + 1]) {
        dp[i][j + 1] = cur - options.skipPenalty;
        back[i][j + 1] = { kind: "skip" };
      }
      if (i < m) {
        const maxK = Math.min(options.maxSentencesPerSegment, n - j);
        for (let k = 0; k <= maxK; k++) {
          // k = 0: segment has no counterpart; scores exactly the floor, so any real match beats it.
          const score = cur + (k === 0 ? options.matchFloor : groupSim(i, j, k));
          if (score > dp[i + 1][j + k]) {
            dp[i + 1][j + k] = score;
            back[i + 1][j + k] = { kind: "take", count: k };
          }
        }
      }
    }
  }

  if (dp[m][n] === NEG) return { ok: false, reason: "no valid alignment found" };

  // Walk back from (m, n).
  const takes: number[] = new Array<number>(m).fill(0);
  const dropped: number[] = [];
  let i = m;
  let j = n;
  while (i > 0 || j > 0) {
    const step = back[i][j];
    if (!step) return { ok: false, reason: "alignment backtrack failed" };
    if (step.kind === "skip") {
      dropped.push(j); // sentence at 0-based index j-1 => number j (1-based position)
      j -= 1;
    } else {
      takes[i - 1] = step.count;
      j -= step.count;
      i -= 1;
    }
  }
  dropped.reverse();

  const out: AlignedSegment[] = [];
  const warnings: string[] = [];
  let cursor = 0;
  let droppedIdx = 0;
  for (let s = 0; s < m; s++) {
    // consume any dropped sentences that sit before this segment's group
    while (droppedIdx < dropped.length && dropped[droppedIdx] - 1 === cursor) {
      cursor++;
      droppedIdx++;
    }
    const k = takes[s];
    if (k === 0) {
      out.push({ segmentId: segs[s].id, sequenceIndex: segs[s].sequenceIndex, firstSentence: 0, lastSentence: 0, englishText: segs[s].text, frenchText: "", similarity: 0, status: "missing" });
      warnings.push(`segment ${segs[s].sequenceIndex}: no matching sentence found in the legacy scripts`);
      continue;
    }
    const sim = groupSim(s, cursor, k);
    const status: SegmentStatus = sim < options.warnBelow ? "low" : "ok";
    out.push({
      segmentId: segs[s].id,
      sequenceIndex: segs[s].sequenceIndex,
      firstSentence: cursor + 1,
      lastSentence: cursor + k,
      englishText: segs[s].text,
      frenchText: french.slice(cursor, cursor + k).map((x) => x.text).join(" "),
      similarity: sim,
      status,
    });
    if (status === "low") warnings.push(`segment ${segs[s].sequenceIndex}: low similarity ${sim.toFixed(2)}`);
    cursor += k;
  }
  if (dropped.length > 0) warnings.push(`sentences not used by any segment: ${dropped.join(", ")}`);

  const lessonScore = out.reduce((acc, s) => acc + s.similarity, 0) / m;
  if (lessonScore < options.minLessonScore) {
    return { ok: false, reason: `scripts do not match the DB segments (mean similarity ${lessonScore.toFixed(2)} < ${options.minLessonScore})` };
  }
  return { ok: true, segments: out, droppedSentences: dropped, lessonScore, warnings };
}
