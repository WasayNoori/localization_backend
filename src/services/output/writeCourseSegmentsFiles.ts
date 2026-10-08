// src/services/output/writeCourseSegmentsFiles.ts
import { and, asc, eq, inArray } from "drizzle-orm";
import type { Database } from "../../db/client.js";
import { courses, lessonSegments, segmentTranslations } from "../../db/schema.js";
import type { ILessonOutputStore } from "../../interfaces/ILessonOutputStore.js";
import { courseLessonOrder } from "../translation/translateCourseLessons.js";
import { courseFolderParts, formatSegmentsText } from "./outputLayout.js";

export interface WriteSegmentsResult {
  courseFolder: string;
  written: { lessonId: string; language: string; segments: number; path: string }[];
  /** Not written, with why (not parsed / not fully translated). Never a partial file. */
  skipped: { lessonId: string; language: string; reason: string }[];
}

export class WriteSegmentsError extends Error {
  constructor(
    public readonly statusCode: 400 | 404,
    message: string
  ) {
    super(message);
  }
}

/**
 * Writes "<Language> Segments.txt" for every parsed lesson of a course, per
 * language ("en" = the English segments). A translated file is written only
 * when every segment has a translation, so a file never mixes languages.
 * Numbering (001, 002…) is the segment order and matches future clip names.
 */
export async function writeCourseSegmentsFiles(
  deps: { db: Database; outputStore: ILessonOutputStore },
  courseId: string,
  options: { languages: string[]; courseFolder?: string; /** Only these lessons (default: the whole course). */ lessonIds?: string[] }
): Promise<WriteSegmentsResult> {
  const { db } = deps;
  const [course] = await db.select().from(courses).where(eq(courses.id, courseId)).limit(1);
  if (!course) throw new WriteSegmentsError(404, `No course with id "${courseId}"`);
  const languages = [...new Set(options.languages.map((l) => l.toLowerCase()))];
  if (!languages.length) throw new WriteSegmentsError(400, "Give at least one language");
  const courseFolder = options.courseFolder?.trim() || course.courseName;
  try {
    courseFolderParts(courseFolder);
  } catch (err) {
    throw new WriteSegmentsError(400, err instanceof Error ? err.message : String(err));
  }

  const result: WriteSegmentsResult = { courseFolder, written: [], skipped: [] };
  const only = options.lessonIds?.length ? new Set(options.lessonIds) : null;
  for (const lessonId of (await courseLessonOrder(db, courseId)).filter((id) => !only || only.has(id))) {
    const segments = await db
      .select({ id: lessonSegments.id, text: lessonSegments.text })
      .from(lessonSegments)
      .where(eq(lessonSegments.lessonId, lessonId))
      .orderBy(asc(lessonSegments.sequenceIndex));
    if (!segments.length) {
      result.skipped.push(...languages.map((language) => ({ lessonId, language, reason: "not parsed" })));
      continue;
    }
    for (const language of languages) {
      let texts = segments.map((s) => s.text);
      if (language !== "en") {
        const rows = await db
          .select({ segmentId: segmentTranslations.segmentId, text: segmentTranslations.translatedText })
          .from(segmentTranslations)
          .where(and(eq(segmentTranslations.targetLanguage, language), inArray(segmentTranslations.segmentId, segments.map((s) => s.id))));
        const byId = new Map(rows.map((r) => [r.segmentId, r.text]));
        const missing = segments.filter((s) => !byId.has(s.id)).length;
        if (missing) {
          result.skipped.push({ lessonId, language, reason: `${missing} of ${segments.length} segments not translated` });
          continue;
        }
        texts = segments.map((s) => byId.get(s.id)!);
      }
      const path = await deps.outputStore.writeSegmentsFile({ courseFolder, language, lessonId }, formatSegmentsText(texts));
      result.written.push({ lessonId, language, segments: texts.length, path });
    }
  }
  return result;
}
