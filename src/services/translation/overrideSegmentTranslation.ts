// src/services/translation/overrideSegmentTranslation.ts
import { and, eq, ne } from "drizzle-orm";
import type { Database } from "../../db/client.js";
import { lessonSegments, segmentTranslations, ttsClips } from "../../db/schema.js";
import { getFormality } from "./getFormality.js";

export class OverrideSegmentTranslationError extends Error {
  constructor(
    public readonly statusCode: 400 | 404,
    message: string
  ) {
    super(message);
  }
}

export interface OverrideSegmentTranslationResult {
  segmentId: string;
  targetLanguage: string;
  translatedText: string;
  editedAt: Date;
  // Same meaning as on retranslate: an active clip still holds audio spoken
  // from the previous text. Regenerate with the lesson generate endpoint + force.
  hasActiveAudio: boolean;
}

/**
 * A person's word on a segment's translation: stores the given text as the
 * segment_translations row, no DeepL call. Clears length_warning (the
 * truncation check is a heuristic; a person has now vouched for the text) so
 * audio can be generated from it. Sending DeepL's own text back = "accept as
 * is". Marked edited_at, so the course translation leaves it alone.
 */
export async function overrideSegmentTranslation(
  db: Database,
  segmentId: string,
  targetLanguage: string,
  translatedText: string
): Promise<OverrideSegmentTranslationResult> {
  if (targetLanguage === "en") {
    throw new OverrideSegmentTranslationError(400, `"en" has no translation — lesson_segments.text is the source text`);
  }
  const text = translatedText.trim();
  if (!text) throw new OverrideSegmentTranslationError(400, "translatedText is empty");

  const [segment] = await db.select({ id: lessonSegments.id }).from(lessonSegments).where(eq(lessonSegments.id, segmentId)).limit(1);
  if (!segment) throw new OverrideSegmentTranslationError(404, `No segment with id "${segmentId}"`);

  const now = new Date();
  const values = {
    translatedText: text,
    // Not a DeepL result: no glossary/context/term instructions were applied.
    deeplGlossaryId: null,
    contextUsed: null,
    termGuidance: null,
    billedCharacters: null,
    // Current setting, so the course translation doesn't see it as stale.
    formality: (await getFormality(db, targetLanguage)) ?? null,
    lengthWarning: null,
    editedAt: now,
    createdAt: now,
  };
  await db
    .insert(segmentTranslations)
    .values({ segmentId, targetLanguage, ...values })
    .onConflictDoUpdate({
      target: [segmentTranslations.segmentId, segmentTranslations.targetLanguage],
      set: values,
    });

  const [activeClip] = await db
    .select({ id: ttsClips.id })
    .from(ttsClips)
    .where(and(eq(ttsClips.segmentId, segmentId), eq(ttsClips.language, targetLanguage), ne(ttsClips.qcStatus, "superseded")))
    .limit(1);

  return { segmentId, targetLanguage, translatedText: text, editedAt: now, hasActiveAudio: !!activeClip };
}
