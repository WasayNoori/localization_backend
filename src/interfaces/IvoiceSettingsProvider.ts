import { VoiceSettings } from "../types/VoiceSettings.js";

export interface IVoiceSettingsProvider {
  getSettings(): Promise<{ voiceId: string; modelId: string; voiceSettings: VoiceSettings }>;
}