const ELEVENLABS_BASE_URL = "https://api.elevenlabs.io";
export class ElevenLabsTtsService {
    secretsProvider;
    constructor(secretsProvider) {
        this.secretsProvider = secretsProvider;
    }
    async synthesize(request) {
        const apiKey = await this.secretsProvider.getSecret("elevenlabs-api-key");
        const url = `${ELEVENLABS_BASE_URL}/v1/text-to-speech/${encodeURIComponent(request.voiceId)}${request.outputFormat ? `?output_format=${encodeURIComponent(request.outputFormat)}` : ""}`;
        const response = await fetch(url, {
            method: "POST",
            headers: {
                "xi-api-key": apiKey,
                "Content-Type": "application/json",
                Accept: "audio/mpeg",
            },
            body: JSON.stringify({
                text: request.text,
                model_id: request.modelId,
                voice_settings: {
                    stability: request.voiceSettings.stability,
                    similarity_boost: request.voiceSettings.similarityBoost,
                    style: request.voiceSettings.style,
                    use_speaker_boost: request.voiceSettings.useSpeakerBoost,
                    speed: request.voiceSettings.speed,
                },
                seed: request.seed,
                previous_text: request.previousText,
                next_text: request.nextText,
                previous_request_ids: request.previousRequestIds,
            }),
        });
        if (!response.ok) {
            const errorText = await response.text().catch(() => "");
            throw new Error(`ElevenLabs request failed (${response.status}): ${errorText}`);
        }
        const requestId = response.headers.get("request-id") ?? "";
        const arrayBuffer = await response.arrayBuffer();
        return {
            audio: Buffer.from(arrayBuffer),
            requestId,
            contentType: response.headers.get("content-type") ?? "audio/mpeg",
        };
    }
    async listVoices() {
        const body = (await this.get("/v1/voices"));
        return body.voices
            .map((v) => ({
            voiceId: v.voice_id,
            name: v.name,
            category: v.category ?? null,
            labels: v.labels ?? {},
            previewUrl: v.preview_url ?? null,
        }))
            .sort((a, b) => a.name.localeCompare(b.name));
    }
    async listModels() {
        const body = (await this.get("/v1/models"));
        return body
            .filter((m) => m.can_do_text_to_speech !== false)
            .map((m) => ({ modelId: m.model_id, name: m.name, languages: (m.languages ?? []).map((l) => l.language_id.toLowerCase()) }));
    }
    async get(path) {
        const apiKey = await this.secretsProvider.getSecret("elevenlabs-api-key");
        const response = await fetch(`${ELEVENLABS_BASE_URL}${path}`, { headers: { "xi-api-key": apiKey } });
        if (!response.ok) {
            throw new Error(`ElevenLabs ${path} failed (${response.status}): ${await response.text().catch(() => "")}`);
        }
        return response.json();
    }
}
//# sourceMappingURL=ElevenLabsTtsService.js.map