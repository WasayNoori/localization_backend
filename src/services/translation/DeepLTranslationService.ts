// src/services/translation/DeepLTranslationService.ts
import type { ISecretsProvider } from "../../interfaces/index.js";
import type {
  ITranslationService,
  TranslateRequest,
  TranslateResult,
} from "../../interfaces/ITranslationService.js";

const DEEPL_BASE_URL = "https://api.deepl.com";

export class DeepLTranslationService implements ITranslationService {
  constructor(private readonly secretsProvider: ISecretsProvider) {}

  async translate(request: TranslateRequest): Promise<TranslateResult> {
    const apiKey = await this.secretsProvider.getSecret("deepl-api-key");

    const response = await fetch(`${DEEPL_BASE_URL}/v2/translate`, {
      method: "POST",
      headers: {
        Authorization: `DeepL-Auth-Key ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        text: [request.text],
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
    const translatedText = body.translations[0]?.text ?? "";

    return { translatedText };
  }
}
