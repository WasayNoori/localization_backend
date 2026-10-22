// src/services/parsing/parseLessonSegments.ts
import { eq } from "drizzle-orm";
import type { Database } from "../../db/client.js";
import { lessons, lessonSegments, type SegmentGranularity } from "../../db/schema.js";
import type { IFileStorageService } from "../../interfaces/IFileStorageService.js";
import type { INlpService } from "../../interfaces/INlpService.js";

export interface ParseLessonDeps {
  db: Database;
  /** Only needed for lessons whose script lives in Box (box_file_id, no script_text). */
  fileStorageService?: IFileStorageService;
  nlpService: INlpService;
}

export interface ParseLessonResult {
  lessonId: string;
  segmentCount: number;
  granularity: SegmentGranularity;
  parsedAt: Date;
}

/**
 * Parses a lesson's English script into lesson_segments: reads the script
 * (lessons.script_text, falling back to Box via box_file_id), splits it via spaCy, and rewrites lesson_segments for this
 * lesson inside one transaction. Re-parsing always replaces prior segments,
 * cascading to delete their segment_translations/tts_clips — a deliberate,
 * destructive, expensive-to-redo operation (see docs/decisions.md).
 *
 * `granularity`: "segment" (sentences packed into ~85-250 characters) or
 * "sentence" (one row per sentence). Omitted = whatever the lesson was parsed
 * with last ("segment" for a lesson never parsed), so automatic re-parses
 * never switch a sentence lesson back to segments.
 */
export async function parseLessonSegments(
  deps: ParseLessonDeps,
  lessonId: string,
  options: { granularity?: SegmentGranularity } = {}
): Promise<ParseLessonResult> {
  const { db } = deps;

  const [lesson] = await db.select().from(lessons).where(eq(lessons.id, lessonId)).limit(1);
  if (!lesson) {
    throw new Error(`No lesson with id "${lessonId}"`);
  }
  const text = await loadScriptText(deps, lesson);

  const granularity = options.granularity ?? (await currentGranularity(db, lessonId)) ?? "segment";
  const { sentences } = await deps.nlpService.segment(text, { granularity });
  const parsedAt = new Date();

  await db.transaction(async (tx) => {
    await tx.delete(lessonSegments).where(eq(lessonSegments.lessonId, lessonId));

    if (sentences.length > 0) {
      await tx.insert(lessonSegments).values(
        sentences.map((sentenceText, index) => ({
          lessonId,
          sequenceIndex: index,
          text: sentenceText,
          granularity,
        }))
      );
    }

    await tx.update(lessons).set({ parsedAt, updatedAt: parsedAt }).where(eq(lessons.id, lessonId));
  });

  return { lessonId, segmentCount: sentences.length, granularity, parsedAt };
}

/** How the lesson's current rows were cut; null when it has none. */
export async function currentGranularity(db: Database, lessonId: string): Promise<SegmentGranularity | null> {
  const [row] = await db
    .select({ granularity: lessonSegments.granularity })
    .from(lessonSegments)
    .where(eq(lessonSegments.lessonId, lessonId))
    .limit(1);
  return row?.granularity ?? null;
}

/**
 * script_text in the DB is the source of truth; box_file_id is only a
 * fallback until the Box folder structure is settled (docs/decisions.md).
 */
async function loadScriptText(
  deps: ParseLessonDeps,
  lesson: typeof lessons.$inferSelect
): Promise<string> {
  if (lesson.scriptText !== null) {
    return lesson.scriptText;
  }
  if (lesson.boxFileId) {
    if (!deps.fileStorageService) throw new Error(`Lesson "${lesson.id}" reads its script from Box, but no file storage is configured`);
    const fileBuffer = await deps.fileStorageService.getFileContent(lesson.boxFileId);
    return fileBuffer.toString("utf-8");
  }
  throw new Error(`Lesson "${lesson.id}" has neither script_text nor box_file_id — nothing to parse`);
}
