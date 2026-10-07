// src/interfaces/IScriptProofreader.ts

/** One proposed fix: replace `original` (an exact, unique substring of the script) with `corrected`. */
export interface ScriptCorrection {
  original: string;
  corrected: string;
  reason: string;
  /** The proofreader itself thinks a person should decide (meaning, numbers, truncated text). */
  needsReview: boolean;
}

/**
 * Proposes minimal fixes for clear errors in an English narration script
 * (run-together sentences, typos, missing/doubled words) before it is parsed.
 * Proposals only — applying them, and deciding which are safe to apply
 * automatically, is applyScriptCorrections' job.
 */
export interface IScriptProofreader {
  proofread(request: { lessonId: string; text: string }): Promise<ScriptCorrection[]>;
}
