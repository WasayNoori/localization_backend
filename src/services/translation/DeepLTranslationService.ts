// src/services/translation/DeepLTranslationService.ts
import type { ISecretsProvider } from "../../interfaces/index.js";
import type {
  GlossaryInfo,
  ITranslationService,
  TranslateManyRequest,
  TranslateManyResult,
  TranslateRequest,
  TranslateResult,
} from "../../interfaces/ITranslationService.js";

const DEEPL_BASE_URL = "https://api.deepl.com";

export class DeepLTranslationService implements ITranslationService {
  constructor(private readonly secretsProvider: ISecretsProvider) {}

  async translate(request: TranslateRequest): Promise<TranslateResult> {
    const { text, ...rest } = request;
    const { translatedTexts } = await this.translateMany({ ...rest, texts: [text] });
    return { translatedText: translatedTexts[0] ?? "" };
  }

  // DeepL takes up to 50 texts per request, all sharing one context.
  async translateMany(request: TranslateManyRequest): Promise<TranslateManyResult> {
    if (request.texts.length === 0) return { translatedTexts: [] };
    if (request.texts.length > 50) {
      const head = await this.translateMany({ ...request, texts: request.texts.slice(0, 50) });
      const tail = await this.translateMany({ ...request, texts: request.texts.slice(50) });
      return { translatedTexts: [...head.translatedTexts, ...tail.translatedTexts] };
    }
    const apiKey = await this.secretsProvider.getSecret("deepl-api-key");

    const response = await fetch(`${DEEPL_BASE_URL}/v2/translate`, {
      method: "POST",
      headers: {
        Authorization: `DeepL-Auth-Key ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        text: request.texts,
        source_lang: (request.sourceLanguage ?? "en").toUpperCase(),
        target_lang: request.targetLanguage,
        glossary_id: request.glossaryId,
        context: request.context,
      }),
    });

    if (!response.ok) {
      const errorText = await response.text().catch(() => "");
      throw new Error(`DeepL request failed (${response.status}): ${errorText}`);
    }

    const body = (await response.json()) as { translations: { text: string }[] };
    if (body.translations.length !== request.texts.length) {
      throw new Error(`DeepL returned ${body.translations.length} translations for ${request.texts.length} texts`);
    }
    return { translatedTexts: body.translations.map((t) => t.text) };
  }

  async listGlossaries(): Promise<GlossaryInfo[]> {
    const apiKey = await this.secretsProvider.getSecret("deepl-api-key");
    const response = await fetch(`${DEEPL_BASE_URL}/v2/glossaries`, {
      headers: { Authorization: `DeepL-Auth-Key ${apiKey}` },
    });
    if (!response.ok) {
      const errorText = await response.text().catch(() => "");
      throw new Error(`DeepL glossary list failed (${response.status}): ${errorText}`);
    }
    const body = (await response.json()) as {
      glossaries: {
        glossary_id: string;
        name: string;
        source_lang: string;
        target_lang: string;
        entry_count: number;
        creation_time: string;
        ready: boolean;
      }[];
    };
    return body.glossaries.map((g) => ({
      id: g.glossary_id,
      name: g.name,
      sourceLanguage: g.source_lang.toLowerCase(),
      targetLanguage: g.target_lang.toLowerCase(),
      entryCount: g.entry_count,
      createdAt: new Date(g.creation_time),
      ready: g.ready,
    }));
  }
}
