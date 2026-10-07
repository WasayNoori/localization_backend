// src/config/voice-defaults.ts
// Starting values for a language's voice settings when Settings creates the
// row and the caller didn't give them. There is deliberately NO default
// voice id: every language must have its voice picked explicitly.
import type { VoiceSettings } from "../types/VoiceSettings.js";

export const DEFAULT_TTS_MODEL = "eleven_multilingual_v2";

export const DEFAULT_VOICE_SETTINGS: VoiceSettings = {
  stability: 0.5,
  similarityBoost: 0.75,
  style: 0,
  speed: 1,
  useSpeakerBoost: true,
};
