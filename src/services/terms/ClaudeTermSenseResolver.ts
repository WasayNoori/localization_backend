// src/services/terms/ClaudeTermSenseResolver.ts
import type { ISecretsProvider } from "../../interfaces/index.js";
import type {
  ITermSenseResolver,
  TermSenseAnswer,
  TermSenseQuestion,
  TermSenseRequest,
} from "../../interfaces/ITermSenseResolver.js";

const ANTHROPIC_URL = "https://api.anthropic.com/v1/messages";
const ANTHROPIC_VERSION = "2023-06-01";
// Segments are ~300-400 characters; 30 questions keeps a request small.
const BATCH_SIZE = 30;

const SYSTEM_PROMPT = `You read English narration from SOLIDWORKS / CAD / simulation / PDM training videos. For each question, a term appears in a segment of narration and has several possible meanings. Decide which listed meaning the term has in that segment.

Answer with:
- outcome "sense" and the senseId of the listed meaning that fits;
- outcome "other" when the term is used in a meaning that none of the listed senses covers;
- outcome "unclear" when you cannot tell, or when the segment uses the term in more than one of the listed meanings.

Judge from the segment and the text before it, in the context of the course. Never translate anything. Give a note (one short sentence) only for "other" and "unclear".

Answer every key using the record_senses tool.`;

const SENSE_TOOL = {
  name: "record_senses",
  description: "Record one answer per question.",
  input_schema: {
    type: "object",
    properties: {
      answers: {
        type: "array",
        items: {
          type: "object",
          properties: {
            key: { type: "string" },
            outcome: { type: "string", enum: ["sense", "other", "unclear"] },
            senseId: { type: "string", description: "Only for outcome \"sense\": the chosen senseId." },
            note: { type: "string", description: "Only for other/unclear: one short sentence." },
          },
          required: ["key", "outcome"],
        },
      },
    },
    required: ["answers"],
  },
} as const;

type RawAnswer = { key: string; outcome: string; senseId?: string; note?: string };

export class ClaudeTermSenseResolver implements ITermSenseResolver {
  constructor(
    private readonly secretsProvider: ISecretsProvider,
    private readonly model: string
  ) {}

  async resolve(request: TermSenseRequest): Promise<TermSenseAnswer[]> {
    const answers: TermSenseAnswer[] = [];
    for (let i = 0; i < request.questions.length; i += BATCH_SIZE) {
      answers.push(...(await this.resolveBatch(request.context, request.questions.slice(i, i + BATCH_SIZE))));
    }
    return answers;
  }

  private async resolveBatch(context: string, questions: TermSenseQuestion[]): Promise<TermSenseAnswer[]> {
    const apiKey = await this.secretsProvider.getSecret("anthropic-api-key");
    const userMessage = [
      "Course context:",
      context,
      "",
      `Answer every question below by calling ${SENSE_TOOL.name} once. Do not reply with text.`,
      "",
      JSON.stringify(
        questions.map((q) => ({
          key: q.key,
          term: q.term,
          textBefore: q.previousText || undefined,
          segment: q.segmentText,
          senses: q.senses.map((s) => ({ senseId: s.senseId, meaning: s.meaning })),
        })),
        null,
        1
      ),
    ].join("\n");

    const response = await fetch(ANTHROPIC_URL, {
      method: "POST",
      headers: { "x-api-key": apiKey, "anthropic-version": ANTHROPIC_VERSION, "content-type": "application/json" },
      body: JSON.stringify({
        model: this.model,
        max_tokens: 8192,
        system: SYSTEM_PROMPT,
        tools: [SENSE_TOOL],
        // "auto": newer models reject a forced tool_choice. A reply without the call throws below.
        tool_choice: { type: "auto" },
        messages: [{ role: "user", content: userMessage }],
      }),
    });
    if (!response.ok) {
      const errorText = await response.text().catch(() => "");
      throw new Error(`Claude term check failed (${response.status}): ${errorText}`);
    }
    const body = (await response.json()) as {
      stop_reason?: string;
      content: { type: string; name?: string; input?: { answers?: RawAnswer[] } }[];
    };
    const raw = body.content.find((c) => c.type === "tool_use" && c.name === SENSE_TOOL.name)?.input?.answers;
    if (!raw) throw new Error(`Claude term check returned no ${SENSE_TOOL.name} call (stop_reason: ${body.stop_reason ?? "unknown"})`);

    // Only keys we asked about; a "sense" answer must name one of that question's senses, else it's unclear.
    const byKey = new Map(questions.map((q) => [q.key, q]));
    const answers: TermSenseAnswer[] = [];
    for (const a of raw) {
      const q = byKey.get(a.key);
      if (!q) continue;
      const note = a.note?.trim() || null;
      if (a.outcome === "sense" && a.senseId && q.senses.some((s) => s.senseId === a.senseId)) {
        answers.push({ key: a.key, outcome: "sense", senseId: a.senseId, note: null });
      } else if (a.outcome === "other") {
        answers.push({ key: a.key, outcome: "other", senseId: null, note });
      } else {
        answers.push({ key: a.key, outcome: "unclear", senseId: null, note: note ?? "No valid sense chosen" });
      }
    }
    return answers;
  }
}
