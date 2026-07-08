// src/types/VoiceSettings.ts

export interface VoiceSettings {
    /** 0–1. Higher = more consistent/monotone, lower = more expressive/variable. */
    stability: number;
    /** 0–1. How closely the output should match the source voice timbre. */
    similarityBoost: number;
    /** 0–1. Style exaggeration; 0 is cheapest and most predictable. Optional. */
    style?: number;
    /** Extra latency/compute for closer speaker match. */
    useSpeakerBoost?: boolean;
    /** 0.7–1.2. Playback speed multiplier. */
    speed?: number;
  }