// src/services/proofreading/ClaudeScriptProofreader.ts
import type { ISecretsProvider } from "../../interfaces/index.js";
import type { IScriptProofreader, ScriptCorrection } from "../../interfaces/IScriptProofreader.js";

const ANTHROPIC_URL = "https://api.anthropic.com/v1/messages";
const ANTHROPIC_VERSION = "2023-06-01";

const SYSTEM_PROMPT = `You proofread English narration scripts for SOLIDWORKS / CAD video training before they are split into sentences, machine-translated and voiced. Fix ONLY clear errors:
- a missing sentence-ending punctuation mark or space that runs two sentences together
- misspelled words (not product names spelled as intended)
- a missing word or a doubled word/punctuation that breaks the grammar (e.g. "to see if works" -> "to see if it works")
- wrong word forms that are clearly typos (its/it's, then/than, to/too)
Never: rephrase, change style or tone, change technical terms, product names (SOLIDWORKS, Simulation, PropertyManager…), UI label capitalization (e.g. "Parts and Assemblies", "Study", "Fixed Geometry" are intentional), numbers or units, bullets or formatting. Never "improve" a correct sentence. When in doubt, do not change it.
Set needsReview true (and still give your best "corrected") when a fix would change meaning, numbers or units, delete more than a doubled word, or when text looks truncated or garbled.
Report fixes with record_corrections: "original" must be an exact substring of the script, copied character for character on one line, long enough (about 4-10 words) to occur only once; "corrected" is the same span with the minimal fix; "reason" is a few words. If nothing needs fixing, call it with an empty list.`;

const TOOL = {
  name: "record_corrections",
  description: "Record the minimal corrections for this script.",
  input_schema: {
    type: "object",
    properties: {
      corrections: {
        type: "array",
        items: {
          type: "object",
          properties: {
            original: { type: "string" },
            corrected: { type: "string" },
            reason: { type: "string" },
            needsReview: { type: "boolean" },
          },
          required: ["original", "corrected", "reason", "needsReview"],
        },
      },
    },
    required: ["corrections"],
  },
} as const;

export class ClaudeScriptProofreader implements IScriptProofreader {
  constructor(
    private readonly secretsProvider: ISecretsProvider,
    private readonly model: string
  ) {}

  async proofread(request: { lessonId: string; text: string }): Promise<ScriptCorrection[]> {
    const apiKey = await this.secretsProvider.getSecret("anthropic-api-key");
    const response = await fetch(ANTHROPIC_URL, {
      method: "POST",
      headers: { "x-api-key": apiKey, "anthropic-version": ANTHROPIC_VERSION, "content-type": "application/json" },
      body: JSON.stringify({
        model: this.model,
        max_tokens: 8192,
        system: SYSTEM_PROMPT,
        tools: [TOOL],
        tool_choice: { type: "auto" }, // forced tool_choice isn't supported by current models
        messages: [
          {
            role: "user",
            content: `Script ${request.lessonId}. Call ${TOOL.name} once; do not reply with text.\n\n<script>\n${request.text}\n</script>`,
          },
        ],
      }),
    });
    if (!response.ok) {
      throw new Error(`Claude proofreading failed (${response.status}): ${await response.text().catch(() => "")}`);
    }
    const body = (await response.json()) as {
      stop_reason?: string;
      content: { type: string; name?: string; input?: { corrections?: Partial<ScriptCorrection>[] } }[];
    };
    const call = body.content.find((c) => c.type === "tool_use" && c.name === TOOL.name);
    if (!call?.input?.corrections) {
      throw new Error(`Claude proofreading returned no ${TOOL.name} call (stop_reason: ${body.stop_reason ?? "unknown"})`);
    }
    return call.input.corrections
      .filter((c) => typeof c.original === "string" && typeof c.corrected === "string")
      .map((c) => ({ original: c.original!, corrected: c.corrected!, reason: c.reason ?? "", needsReview: !!c.needsReview }));
  }
}
