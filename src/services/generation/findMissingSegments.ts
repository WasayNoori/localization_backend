// src/services/generation/findMissingSegments.ts
import { and, eq, inArray, ne } from "drizzle-orm";
import type { Database } from "../../db/client.js";
import { lessonSegments, ttsClips } from "../../db/schema.js";
import { VoiceNotConfiguredError, type IVoiceSettingsProvider } from "../../interfaces/IvoiceSettingsProvider.js";

export interface ActiveClip {
  id: string;
  segmentId: string;
  boxFileId: string | null;
  voiceId: string;
}

export interface MissingSegmentsResult {
  segments: (typeof lessonSegments.$inferSelect)[];
  /** Active clips still spoken with the current voice (all active clips when no voice was given). */
  activeClips: ActiveClip[];
  /** Active clips made with a voice other than `currentVoiceId` — they count as missing. */
  voiceChangedClips: ActiveClip[];
  missingSegments: (typeof lessonSegments.$inferSelect)[];
}

/**
 * Segments missing an active (non-superseded) tts_clips row for one lesson +
 * target language — the cheap, DB-only "what's left to generate" check
 * shared by generateLocalizationForLesson (the resume loop), the course audio
 * job and the course-status read endpoint. See docs/pipeline-flow.md,
 * generate-stage section, for the full write-up of what "active" means here.
 *
 * With `currentVoiceId`, an active clip made with a different voice (the
 * voice was changed in Settings since) is reported in voiceChangedClips and
 * its segment counts as missing — so a plain "generate missing" redoes it.
 */
export async function findMissingSegments(
  db: Database,
  lessonId: string,
  targetLanguage: string,
  currentVoiceId?: string | null
): Promise<MissingSegmentsResult> {
  const segments = await db
    .select()
    .from(lessonSegments)
    .where(eq(lessonSegments.lessonId, lessonId))
    .orderBy(lessonSegments.sequenceIndex);

  if (segments.length === 0) {
    return { segments: [], activeClips: [], voiceChangedClips: [], missingSegments: [] };
  }

  const segmentIds = segments.map((s) => s.id);

  // "Active" mirrors the tts_clips partial unique index: any row whose
  // qc_status isn't 'superseded' already satisfies this segment+language.
  const allActive = await db
    .select({ id: ttsClips.id, segmentId: ttsClips.segmentId, boxFileId: ttsClips.boxFileId, voiceId: ttsClips.voiceId })
    .from(ttsClips)
    .where(
      and(
        inArray(ttsClips.segmentId, segmentIds),
        eq(ttsClips.language, targetLanguage),
        ne(ttsClips.qcStatus, "superseded")
      )
    );
  const voiceChanged = (c: ActiveClip) => !!currentVoiceId && c.voiceId !== currentVoiceId;
  const activeClips = allActive.filter((c) => !voiceChanged(c));
  const voiceChangedClips = allActive.filter(voiceChanged);
  const activeSegmentIds = new Set(activeClips.map((c) => c.segmentId));

  const missingSegments = segments.filter((s) => !activeSegmentIds.has(s.id));

  return { segments, activeClips, voiceChangedClips, missingSegments };
}

/** The language's configured voice id, or null when none is set (callers then skip voice-change detection). */
export async function currentVoiceIdFor(provider: IVoiceSettingsProvider, language: string): Promise<string | null> {
  try {
    return (await provider.getSettings(language)).voiceId;
  } catch (err) {
    if (err instanceof VoiceNotConfiguredError) return null;
    throw err;
  }
}
