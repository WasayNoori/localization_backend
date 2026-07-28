// src/services/generation/findMissingSegments.ts
import { and, eq, inArray, ne } from "drizzle-orm";
import type { Database } from "../../db/client.js";
import { lessonSegments, ttsClips } from "../../db/schema.js";

export interface MissingSegmentsResult {
  segments: (typeof lessonSegments.$inferSelect)[];
  activeClips: { id: string; segmentId: string; boxFileId: string | null }[];
  missingSegments: (typeof lessonSegments.$inferSelect)[];
}

/**
 * Segments missing an active (non-superseded) tts_clips row for one lesson +
 * target language — the cheap, DB-only "what's left to generate" check
 * shared by generateLocalizationForLesson (the resume loop) and the
 * course-status read endpoint. See docs/pipeline-flow.md, generate-stage
 * section, for the full write-up of what "active" means here.
 */
export async function findMissingSegments(
  db: Database,
  lessonId: string,
  targetLanguage: string
): Promise<MissingSegmentsResult> {
  const segments = await db
    .select()
    .from(lessonSegments)
    .where(eq(lessonSegments.lessonId, lessonId))
    .orderBy(lessonSegments.sequenceIndex);

  if (segments.length === 0) {
    return { segments: [], activeClips: [], missingSegments: [] };
  }

  const segmentIds = segments.map((s) => s.id);

  // "Active" mirrors the tts_clips partial unique index: any row whose
  // qc_status isn't 'superseded' already satisfies this segment+language.
  const activeClips = await db
    .select({ id: ttsClips.id, segmentId: ttsClips.segmentId, boxFileId: ttsClips.boxFileId })
    .from(ttsClips)
    .where(
      and(
        inArray(ttsClips.segmentId, segmentIds),
        eq(ttsClips.language, targetLanguage),
        ne(ttsClips.qcStatus, "superseded")
      )
    );
  const activeSegmentIds = new Set(activeClips.map((c) => c.segmentId));

  const missingSegments = segments.filter((s) => !activeSegmentIds.has(s.id));

  return { segments, activeClips, missingSegments };
}
