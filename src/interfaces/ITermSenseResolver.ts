// src/interfaces/ITermSenseResolver.ts

/** One sense the resolver may choose. */
export interface TermSenseOption {
  senseId: string;
  /** English description, e.g. "a tab of a dialog box or PropertyManager". */
  meaning: string;
}

/** "Which sense does this term have in this segment?" */
export interface TermSenseQuestion {
  /** Caller's id for matching answers back. */
  key: string;
  term: string;
  /** The segment (English narration) the term appears in. */
  segmentText: string;
  /** The segment before it, for context (may be empty). */
  previousText: string;
  senses: TermSenseOption[];
}

export interface TermSenseRequest {
  /** Course and lesson names, for subject context (CAD, Simulation, PDM…). */
  context: string;
  questions: TermSenseQuestion[];
}

export interface TermSenseAnswer {
  key: string;
  /** sense = one of the listed senses; other = a meaning not listed; unclear = can't tell. */
  outcome: "sense" | "other" | "unclear";
  senseId: string | null;
  /** One short sentence, for other/unclear. */
  note: string | null;
}

/**
 * Picks the sense of an ambiguous term in a sentence. Only chooses among the
 * listed senses — never proposes a translation; translations come from the
 * term's senses (ambiguous_term_senses).
 */
export interface ITermSenseResolver {
  resolve(request: TermSenseRequest): Promise<TermSenseAnswer[]>;
}
