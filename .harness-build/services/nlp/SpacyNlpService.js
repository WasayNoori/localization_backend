export class SpacyNlpService {
    baseUrl;
    constructor(baseUrl) {
        this.baseUrl = baseUrl;
    }
    async segment(text, correctGrammar = false) {
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
        const body = (await response.json());
        return {
            sentences: body.sentences,
            originalLength: body.original_length,
            grammarCorrected: body.grammar_corrected,
        };
    }
}
//# sourceMappingURL=SpacyNlpService.js.map