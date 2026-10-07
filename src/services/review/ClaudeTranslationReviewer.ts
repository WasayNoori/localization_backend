// src/services/review/ClaudeTranslationReviewer.ts
import { languageName } from "../../config/languages.js";
import type { ISecretsProvider } from "../../interfaces/index.js";
import type {
  ITranslationReviewer,
  ReviewItem,
  ReviewRequest,
  ReviewVerdict,
} from "../../interfaces/ITranslationReviewer.js";

const ANTHROPIC_URL = "https://api.anthropic.com/v1/messages";
const ANTHROPIC_VERSION = "2023-06-01";
// Short titles/descriptions: 60 per request keeps prompts small and responses fast.
const BATCH_SIZE = 60;


const KIND_LABEL: Record<ReviewItem["kind"], string> = {
  course: "course name",
  courseDescription: "course description",
  section: "section title",
  lessonName: "lesson name",
  lessonDescription: "lesson description",
};

const SYSTEM_PROMPT = `You check machine translations of e-learning course scaffolding — course names and descriptions, section titles, lesson names and lesson descriptions — for SOLIDWORKS / CAD engineering training. The English is the source. The translations come from DeepL, which is the reference translator.

Your only job is to catch translations that are clearly WRONG. Flag an item only when:
- its meaning contradicts the English or loses what it says, or
- it makes no sense in a CAD / engineering-simulation context (for example a technical term rendered with an unrelated everyday meaning), or
- it is in the wrong language, untranslated where translation was clearly needed, truncated or garbled.

Do NOT flag style, tone, word order, terminology preferences, capitalisation, or anything you would merely phrase differently. Product and feature names left in English (SOLIDWORKS, eDrawings, PropertyManager, Simulation) are fine. Never propose an alternative translation. When in doubt, do not flag.

Return a verdict for every key using the record_verdicts tool. Give a reason (one short English sentence saying what is wrong) only for flagged items.`;

const VERDICT_TOOL = {
  name: "record_verdicts",
  description: "Record one verdict per reviewed item.",
  input_schema: {
    type: "object",
    properties: {
      verdicts: {
        type: "array",
        items: {
          type: "object",
          properties: {
            key: { type: "string" },
            flagged: { type: "boolean" },
            reason: { type: "string", description: "Only when flagged: what is clearly wrong, one sentence." },
          },
          required: ["key", "flagged"],
        },
      },
    },
    required: ["verdicts"],
  },
} as const;

export class ClaudeTranslationReviewer implements ITranslationReviewer {
  constructor(
    private readonly secretsProvider: ISecretsProvider,
    private readonly model: string
  ) {}

  async review(request: ReviewRequest): Promise<ReviewVerdict[]> {
    const verdicts: ReviewVerdict[] = [];
    for (let i = 0; i < request.items.length; i += BATCH_SIZE) {
      verdicts.push(...(await this.reviewBatch(request, request.items.slice(i, i + BATCH_SIZE))));
    }
    return verdicts;
  }

  private async reviewBatch(request: ReviewRequest, items: ReviewItem[]): Promise<ReviewVerdict[]> {
    const apiKey = await this.secretsProvider.getSecret("anthropic-api-key");
    const language = languageName(request.targetLanguage);

    const userMessage = [
      `Target language: ${language} (${request.targetLanguage})`,
      "",
      "Course outline (English), for context:",
      request.context,
      "",
      `Record a verdict for every item below by calling ${VERDICT_TOOL.name} once. Do not reply with text.`,
      "",
      "Items to check:",
      JSON.stringify(
        items.map((it) => ({ key: it.key, type: KIND_LABEL[it.kind], english: it.source, translation: it.translation })),
        null,
        1
      ),
    ].join("\n");

    const response = await fetch(ANTHROPIC_URL, {
      method: "POST",
      headers: {
        "x-api-key": apiKey,
        "anthropic-version": ANTHROPIC_VERSION,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: this.model,
        max_tokens: 8192,
        system: SYSTEM_PROMPT,
        tools: [VERDICT_TOOL],
        // "auto", not a forced tool: newer models reject forced tool_choice
        // ("tool"/"any"). The prompt requires the call; a reply without it throws below.
        tool_choice: { type: "auto" },
        messages: [{ role: "user", content: userMessage }],
      }),
    });

    if (!response.ok) {
      const errorText = await response.text().catch(() => "");
      throw new Error(`Claude review request failed (${response.status}): ${errorText}`);
    }

    const body = (await response.json()) as {
      stop_reason?: string;
      content: { type: string; name?: string; input?: { verdicts?: { key: string; flagged: boolean; reason?: string }[] } }[];
    };
    const toolUse = body.content.find((c) => c.type === "tool_use" && c.name === VERDICT_TOOL.name);
    if (!toolUse?.input?.verdicts) {
      throw new Error(`Claude review returned no ${VERDICT_TOOL.name} call (stop_reason: ${body.stop_reason ?? "unknown"})`);
    }
    const raw = toolUse.input.verdicts;

    // Only keys we asked about; an item Claude skipped stays unreviewed (no verdict).
    const asked = new Set(items.map((it) => it.key));
    return raw
      .filter((v) => asked.has(v.key))
      .map((v) => ({ key: v.key, flagged: !!v.flagged, reason: v.flagged ? (v.reason?.trim() || "Flagged without a reason") : null }));
  }
}
