// src/services/parsing/parseLessonSegments.ts
import { eq } from "drizzle-orm";
import type { Database } from "../../db/client.js";
import { lessons, lessonSegments } from "../../db/schema.js";
import type { IFileStorageService } from "../../interfaces/IFileStorageService.js";
import type { INlpService } from "../../interfaces/INlpService.js";

export interface ParseLessonDeps {
  db: Database;
  fileStorageService: IFileStorageService;
  nlpService: INlpService;
}

export interface ParseLessonResult {
  lessonId: string;
  segmentCount: number;
  parsedAt: Date;
}

/**
 * Parses a lesson's English script into lesson_segments: fetches the script
 * from Box, splits it via spaCy, and rewrites lesson_segments for this
 * lesson inside one transaction. Re-parsing always replaces prior segments,
 * cascading to delete their segment_translations/tts_clips — a deliberate,
 * destructive, expensive-to-redo operation (see docs/decisions.md).
 */
export async function parseLessonSegments(deps: ParseLessonDeps, lessonId: string): Promise<ParseLessonResult> {
  const { db } = deps;

  const [lesson] = await db.select().from(lessons).where(eq(lessons.id, lessonId)).limit(1);
  if (!lesson) {
    throw new Error(`No lesson with id "${lessonId}"`);
  }
  if (!lesson.boxFileId) {
    throw new Error(`Lesson "${lessonId}" has no box_file_id set — nothing to parse`);
  }

  const fileBuffer = await deps.fileStorageService.getFileContent(lesson.boxFileId);
  const text = fileBuffer.toString("utf-8");

  const { sentences } = await deps.nlpService.segment(text);
  const parsedAt = new Date();

  await db.transaction(async (tx) => {
    await tx.delete(lessonSegments).where(eq(lessonSegments.lessonId, lessonId));

    if (sentences.length > 0) {
      await tx.insert(lessonSegments).values(
        sentences.map((sentenceText, index) => ({
          lessonId,
          sequenceIndex: index,
          text: sentenceText,
        }))
      );
    }

    await tx.update(lessons).set({ parsedAt, updatedAt: parsedAt }).where(eq(lessons.id, lessonId));
  });

  return { lessonId, segmentCount: sentences.length, parsedAt };
}
