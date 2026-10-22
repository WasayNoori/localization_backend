import type { SegmentGranularity } from "../db/schema.js";

export interface NlpSegmentResult {
  /** The pieces, in order: segments (~85-250 characters) or single sentences, per `granularity`. */
  sentences: string[];
  granularity: SegmentGranularity;
  originalLength: number;
  grammarCorrected: boolean;
}

export interface INlpService {
  /** granularity: "segment" (default) packs sentences into segments; "sentence" returns one per sentence. */
  segment(text: string, options?: { correctGrammar?: boolean; granularity?: SegmentGranularity }): Promise<NlpSegmentResult>;
}
