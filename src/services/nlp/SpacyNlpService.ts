// src/services/nlp/SpacyNlpService.ts
import type { SegmentGranularity } from "../../db/schema.js";
import type { INlpService, NlpSegmentResult } from "../../interfaces/index.js";

export class SpacyNlpService implements INlpService {
  constructor(private readonly baseUrl: string) {}

  async segment(
    text: string,
    { correctGrammar = false, granularity = "segment" }: { correctGrammar?: boolean; granularity?: SegmentGranularity } = {}
  ): Promise<NlpSegmentResult> {
    const url = `${this.baseUrl.replace(/\/+$/, "")}/process`;

    const response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text, correctGrammar, granularity }),
    });

    if (!response.ok) {
      const errorText = await response.text().catch(() => "");
      throw new Error(`spaCy request failed (${response.status}): ${errorText}`);
    }

    const body = (await response.json()) as {
      sentences: string[];
      original_length: number;
      grammar_corrected: boolean;
      /** Missing from services older than the granularity option — they always return segments. */
      granularity?: SegmentGranularity;
    };
    const returned = body.granularity ?? "segment";
    if (returned !== granularity) {
      throw new Error(`The spaCy service returned ${returned}s, not ${granularity}s — it's older than the granularity option; update and restart it`);
    }

    return {
      sentences: body.sentences,
      granularity: returned,
      originalLength: body.original_length,
      grammarCorrected: body.grammar_corrected,
    };
  }
}
