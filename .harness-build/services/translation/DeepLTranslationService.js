const DEEPL_BASE_URL = "https://api.deepl.com";
export class DeepLTranslationService {
    secretsProvider;
    constructor(secretsProvider) {
        this.secretsProvider = secretsProvider;
    }
    async translate(request) {
        const { text, ...rest } = request;
        const { translatedTexts } = await this.translateMany({ ...rest, texts: [text] });
        return { translatedText: translatedTexts[0] ?? "" };
    }
    // DeepL takes up to 50 texts per request, all sharing one context.
    async translateMany(request) {
        if (request.texts.length === 0)
            return { translatedTexts: [] };
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
                formality: request.formality,
            }),
        });
        if (!response.ok) {
            const errorText = await response.text().catch(() => "");
            throw new Error(`DeepL request failed (${response.status}): ${errorText}`);
        }
        const body = (await response.json());
        if (body.translations.length !== request.texts.length) {
            throw new Error(`DeepL returned ${body.translations.length} translations for ${request.texts.length} texts`);
        }
        return { translatedTexts: body.translations.map((t) => t.text) };
    }
    async listGlossaries() {
        const apiKey = await this.secretsProvider.getSecret("deepl-api-key");
        const response = await fetch(`${DEEPL_BASE_URL}/v2/glossaries`, {
            headers: { Authorization: `DeepL-Auth-Key ${apiKey}` },
        });
        if (!response.ok) {
            const errorText = await response.text().catch(() => "");
            throw new Error(`DeepL glossary list failed (${response.status}): ${errorText}`);
        }
        const body = (await response.json());
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
//# sourceMappingURL=DeepLTranslationService.js.map