// src/services/tts/ElevenLabsTtsService.ts
import type { ISecretsProvider } from "../../interfaces/index.js";
import type {
  ITextToSpeechService,
  SynthesizeSpeechRequest,
  SynthesizeSpeechResult,
  TtsModel,
  TtsUsage,
  TtsVoice,
} from "../../interfaces/ITextToSpeechService.js";

const ELEVENLABS_BASE_URL = "https://api.elevenlabs.io";

// The UI polls usage; one upstream call per minute is plenty.
const USAGE_CACHE_MS = 60_000;

// Models that accept language_code (force the spoken language). Multilingual v2
// doesn't and may reject the request, so it's only sent for these.
const LANGUAGE_CODE_MODELS = /^eleven_(v3|v4|flash_v2_5|turbo_v2_5)/;

export class ElevenLabsTtsService implements ITextToSpeechService {
  private usageCache: { value: TtsUsage; expiresAt: number } | null = null;

  constructor(private readonly secretsProvider: ISecretsProvider) {}

  async synthesize(request: SynthesizeSpeechRequest): Promise<SynthesizeSpeechResult> {
    const apiKey = await this.secretsProvider.getSecret("elevenlabs-api-key");

    const url = `${ELEVENLABS_BASE_URL}/v1/text-to-speech/${encodeURIComponent(request.voiceId)}${
      request.outputFormat ? `?output_format=${encodeURIComponent(request.outputFormat)}` : ""
    }`;

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
        ...(request.languageCode && LANGUAGE_CODE_MODELS.test(request.modelId) ? { language_code: request.languageCode } : {}),
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

  async listVoices(): Promise<TtsVoice[]> {
    const body = (await this.get("/v1/voices")) as {
      voices: { voice_id: string; name: string; category?: string; labels?: Record<string, string>; preview_url?: string }[];
    };
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

  async listModels(): Promise<TtsModel[]> {
    const body = (await this.get("/v1/models")) as {
      model_id: string;
      name: string;
      can_do_text_to_speech?: boolean;
      languages?: { language_id: string }[];
    }[];
    return body
      .filter((m) => m.can_do_text_to_speech !== false)
      .map((m) => ({ modelId: m.model_id, name: m.name, languages: (m.languages ?? []).map((l) => l.language_id.toLowerCase()) }));
  }

  async getUsage(): Promise<TtsUsage> {
    if (this.usageCache && Date.now() < this.usageCache.expiresAt) return this.usageCache.value;
    const s = (await this.get("/v1/user/subscription")) as {
      character_count: number;
      character_limit: number;
      next_character_count_reset_unix?: number | null;
      tier?: string;
    };
    const value: TtsUsage = {
      used: s.character_count,
      limit: s.character_limit,
      remaining: Math.max(0, s.character_limit - s.character_count),
      resetsAt: s.next_character_count_reset_unix ? new Date(s.next_character_count_reset_unix * 1000).toISOString() : null,
      tier: s.tier ?? null,
      fetchedAt: new Date().toISOString(),
    };
    this.usageCache = { value, expiresAt: Date.now() + USAGE_CACHE_MS };
    return value;
  }

  private async get(path: string): Promise<unknown> {
    const apiKey = await this.secretsProvider.getSecret("elevenlabs-api-key");
    const response = await fetch(`${ELEVENLABS_BASE_URL}${path}`, { headers: { "xi-api-key": apiKey } });
    if (!response.ok) {
      throw new Error(`ElevenLabs ${path} failed (${response.status}): ${await response.text().catch(() => "")}`);
    }
    return response.json();
  }
}
