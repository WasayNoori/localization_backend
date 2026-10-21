// src/services/output/saveCourseOutline.ts
// Saves the course outline workbook (built by the console) into the course's Box folder.
import { eq } from "drizzle-orm";
import type { Database } from "../../db/client.js";
import { courses } from "../../db/schema.js";
import type { IFileStorageService } from "../../interfaces/IFileStorageService.js";
import { languageFolder, outlineFileName } from "./outputLayout.js";

export class CourseOutlineError extends Error {
  constructor(
    message: string,
    readonly statusCode: 400 | 404
  ) {
    super(message);
  }
}

export interface SavedCourseOutline {
  fileId: string;
  /** e.g. "ES/25SWEssParts Outline ES.xlsx", relative to the course folder. */
  path: string;
  /** Same content as the file already in Box — nothing uploaded. */
  unchanged: boolean;
}

/**
 * <course Box folder>/<LANG>/<courseId> Outline <LANG>.xlsx. An existing file
 * of that name gets a new version (same Box file id, history kept), so the
 * outline is replaced rather than duplicated. The language folder is created
 * if missing.
 */
export async function saveCourseOutline(
  deps: { db: Database; fileStorageService: IFileStorageService },
  courseId: string,
  language: string,
  content: Buffer
): Promise<SavedCourseOutline> {
  const [course] = await deps.db.select({ boxFolderId: courses.boxFolderId }).from(courses).where(eq(courses.id, courseId)).limit(1);
  if (!course) throw new CourseOutlineError(`No course with id "${courseId}"`, 404);
  if (!course.boxFolderId) throw new CourseOutlineError(`Course "${courseId}" has no Box folder — set it on the course page`, 400);
  if (!/^[a-z]{2}$/.test(language)) throw new CourseOutlineError(`Not a language code: "${language}"`, 400);
  // .xlsx is a zip: "PK\x03\x04".
  if (content.length < 4 || content.readUInt32LE(0) !== 0x04034b50) throw new CourseOutlineError("The body isn't an .xlsx file", 400);

  const folderId = await deps.fileStorageService.ensureFolderPath(course.boxFolderId, [languageFolder(language)]);
  const name = outlineFileName(courseId, language);
  const saved = await deps.fileStorageService.saveFile(folderId, name, content);
  return { fileId: saved.fileId, path: `${languageFolder(language)}/${name}`, unchanged: saved.unchanged };
}
