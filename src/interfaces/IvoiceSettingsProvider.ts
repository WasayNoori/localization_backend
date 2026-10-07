import type { VoiceSettings } from "../types/VoiceSettings.js";

/** The ElevenLabs configuration one language speaks with. */
export interface LanguageVoiceConfig {
  language: string;
  voiceId: string;
  modelId: string;
  voiceSettings: VoiceSettings;
}

export class VoiceNotConfiguredError extends Error {
  constructor(public readonly language: string) {
    super(`No voice configured for "${language}" — set it in Settings (PUT /languages/${language}/voice-settings)`);
  }
}

/** Per-language voice configuration. Never falls back to a default voice: an unconfigured language throws. */
export interface IVoiceSettingsProvider {
  getSettings(language: string): Promise<LanguageVoiceConfig>;
}
