import type { IVoiceSettingsProvider } from "../../interfaces/IvoiceSettingsProvider.js";

export class HardcodedVoiceSettingsProvider implements IVoiceSettingsProvider {
  async getSettings() {
    return {
      voiceId: "21m00Tcm4TlvDq8ikWAM",
      modelId: "eleven_multilingual_v2",
      voiceSettings: {
        stability: 0.5,
        similarityBoost: 0.75,
        style: 0,
        useSpeakerBoost: true,
        speed: 1,
      },
    };
  }
}
