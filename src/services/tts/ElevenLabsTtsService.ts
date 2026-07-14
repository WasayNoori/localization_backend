// src/services/tts/ElevenLabsTtsService.ts
import type { ISecretsProvider } from "../../interfaces/index.js";
import type {
  ITextToSpeechService,
  SynthesizeSpeechRequest,
  SynthesizeSpeechResult,
} from "../../interfaces/ITextToSpeechService.js";

const ELEVENLABS_BASE_URL = "https://api.elevenlabs.io";

export class ElevenLabsTtsService implements ITextToSpeechService {
  constructor(private readonly secretsProvider: ISecretsProvider) {}

  async synthesize(request: SynthesizeSpeechRequest): Promise<SynthesizeSpeechResult> {
    const apiKey = await this.secretsProvider.getSecret("elevenlabs-api-key");

    const url = `${ELEVENLABS_BASE_URL}/v1/text-to-speech/${encodeURIComponent(request.voiceId)}`;

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
}