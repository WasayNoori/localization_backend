// src/interfaces/ITextToSpeechService.ts
import type { VoiceSettings } from "../types/VoiceSettings.js";

export interface SynthesizeSpeechRequest {
  text: string;
  voiceId: string;
  modelId: string;
  voiceSettings: VoiceSettings;

  /** Reproducibility — same seed + inputs ≈ same output, best-effort only. */
  seed?: number;

  /** Context stitching for adjacent clips in a multi-segment script. */
  previousText?: string;
  nextText?: string;

  /** Request IDs from prior calls, for voice continuity (max 3). */
  previousRequestIds?: string[];

  outputFormat?: string; // e.g. "mp3_44100_128"
}

export interface SynthesizeSpeechResult {
  audio: Buffer;
  requestId: string;
  contentType: string;
}

export interface ITextToSpeechService {
  synthesize(request: SynthesizeSpeechRequest): Promise<SynthesizeSpeechResult>;
}