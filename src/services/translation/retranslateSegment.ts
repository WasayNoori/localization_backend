// src/services/translation/retranslateSegment.ts
import { and, eq, ne } from "drizzle-orm";
import type { Database } from "../../db/client.js";
import { lessonSegments, ttsClips } from "../../db/schema.js";
import type { ITranslationService } from "../../interfaces/ITranslationService.js";
import { translateAndStoreSegment } from "./translateAndStoreSegment.js";
import { loadLessonContext } from "./buildLessonContext.js";

export interface RetranslateSegmentDeps {
  db: Database;
  translationService: ITranslationService;
}

export interface RetranslateSegmentResult {
  segmentId: string;
  targetLanguage: string;
  translatedText: string;
  // Informational only. An active tts_clips row for this segment+language
  // still holds audio synthesized from the discarded translation —
  // retranslating never touches tts_clips itself (see docs/decisions.md).
  // Regenerating audio from the new text is a separate, explicit call to
  // the lesson-level generate endpoint.
  hasActiveAudio: boolean;
}

/**
 * Re-translates one segment+language via DeepL (with full-lesson context),
 * overwriting its segment_translations row. Deliberately decoupled from audio generation
 * — translation QC is an iterative, segment-at-a-time process, and
 * re-running ElevenLabs on every retry would be needlessly expensive. See
 * docs/decisions.md.
 */
export async function retranslateSegment(
  deps: RetranslateSegmentDeps,
  segmentId: string,
  targetLanguage: string
): Promise<RetranslateSegmentResult> {
  const { db } = deps;

  const [segment] = await db.select().from(lessonSegments).where(eq(lessonSegments.id, segmentId)).limit(1);
  if (!segment) {
    throw new Error(`No segment with id "${segmentId}"`);
  }
  if (targetLanguage === "en") {
    throw new Error(`"en" has no translation to regenerate — lesson_segments.text is the source text`);
  }

  // translateAndStoreSegment overwrites the existing row in place (no
  // status/audit history on segment_translations — see docs/decisions.md).
  const { segments, context } = await loadLessonContext(db, segment.lessonId);
  const index = segments.findIndex((s) => s.id === segmentId);

  const { translatedText } = await translateAndStoreSegment(
    deps,
    segmentId,
    segment.text,
    targetLanguage,
    context.forIndex(index)
  );

  const [activeClip] = await db
    .select({ id: ttsClips.id })
    .from(ttsClips)
    .where(
      and(eq(ttsClips.segmentId, segmentId), eq(ttsClips.language, targetLanguage), ne(ttsClips.qcStatus, "superseded"))
    )
    .limit(1);

  return { segmentId, targetLanguage, translatedText, hasActiveAudio: !!activeClip };
}
