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

  outputFormat?: string; // e.g. "mp3_44100_192"

  /**
   * The language to speak (lowercase ISO 639-1, e.g. "fr"). Providers apply it
   * only for models that support forcing a language; others ignore it.
   */
  languageCode?: string;
}

export interface SynthesizeSpeechResult {
  audio: Buffer;
  requestId: string;
  contentType: string;
}

export interface TtsVoice {
  voiceId: string;
  name: string;
  /** e.g. "premade", "cloned", "professional". */
  category: string | null;
  /** Free-form labels from the provider, e.g. { accent: "british", gender: "female" }. */
  labels: Record<string, string>;
  previewUrl: string | null;
}

export interface TtsModel {
  modelId: string;
  name: string;
  /** Language codes the model supports, lowercase (e.g. "en", "fr"). */
  languages: string[];
}

export interface TtsUsage {
  /** Characters used in the current billing period. */
  used: number;
  limit: number;
  remaining: number;
  /** ISO timestamp of the next quota reset; null if the provider doesn't say. */
  resetsAt: string | null;
  /** Subscription tier, e.g. "creator". */
  tier: string | null;
  /** When this snapshot was fetched from the provider (ISO); usage may be cached briefly. */
  fetchedAt: string;
}

export interface ITextToSpeechService {
  synthesize(request: SynthesizeSpeechRequest): Promise<SynthesizeSpeechResult>;
  /** Voices available to the account. */
  listVoices(): Promise<TtsVoice[]>;
  /** Text-to-speech models available to the account. */
  listModels(): Promise<TtsModel[]>;
  /** Character quota for the current billing period. May be cached for up to a minute. */
  getUsage(): Promise<TtsUsage>;
}