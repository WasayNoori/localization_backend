// src/services/nlp/SpacyNlpService.ts
import type { INlpService, NlpSegmentResult } from "../../interfaces/index.js";

export class SpacyNlpService implements INlpService {
  constructor(private readonly baseUrl: string) {}

  async segment(text: string, correctGrammar = false): Promise<NlpSegmentResult> {
    const url = `${this.baseUrl.replace(/\/+$/, "")}/process`;

    const response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text, correctGrammar }),
    });

    if (!response.ok) {
      const errorText = await response.text().catch(() => "");
      throw new Error(`spaCy request failed (${response.status}): ${errorText}`);
    }

    const body = (await response.json()) as {
      sentences: string[];
      original_length: number;
      grammar_corrected: boolean;
    };

    return {
      sentences: body.sentences,
      originalLength: body.original_length,
      grammarCorrected: body.grammar_corrected,
    };
  }
}
