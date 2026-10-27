// src/services/output/copyToLessonFolders.ts
// TEMPORARY layout for an outside automation: every lesson's files for every
// language side by side, <course>/<lessonId>/, copied from the normal layout
// <course>/<LANG>/<lessonId>/. Nothing reads these copies back; to revert,
// delete the <course>/<lessonId> folders. See docs/decisions.md.
import { eq } from "drizzle-orm";
import { languageName } from "../../config/languages.js";
import type { Database } from "../../db/client.js";
import { courses } from "../../db/schema.js";
import type { CopyOutcome, IFileStorageService, StoredItem } from "../../interfaces/IFileStorageService.js";
import { courseLessonOrder } from "../translation/translateCourseLessons.js";
import { languageFolder, segmentsFileName } from "./outputLayout.js";

export interface CopyToLessonFoldersOptions {
  /** Lower-case codes ("en", "es"). Default: every language folder the course has in Box. */
  languages?: string[];
  /** Stop starting new lessons after this time (ms since epoch); re-running continues. */
  deadline?: number;
  /** Lessons copied at the same time (Box rate-limits; 3 is safe). */
  concurrency?: number;
  onLesson?: (language: string, lessonId: string, files: number) => void;
}

export interface CopyToLessonFoldersResult {
  courseId: string;
  counts: Record<CopyOutcome, number>;
  /** Lesson folders created under the course folder. */
  foldersCreated: number;
  /** Per language: lessons with nothing in the normal layout (no script, not generated yet). */
  nothingToCopy: Record<string, string[]>;
  errors: { language: string; lessonId: string; file?: string; error: string }[];
  /** False when the deadline stopped it early — run again to continue. */
  done: boolean;
}

export async function copyToLessonFolders(
  deps: { db: Database; fileStorageService: IFileStorageService },
  courseId: string,
  options: CopyToLessonFoldersOptions = {}
): Promise<CopyToLessonFoldersResult> {
  const { db, fileStorageService: box } = deps;
  const [course] = await db.select().from(courses).where(eq(courses.id, courseId)).limit(1);
  if (!course) throw new Error(`No course with id "${courseId}"`);
  if (!course.boxFolderId) throw new Error(`Course "${courseId}" has no Box folder`);
  const courseFolderId = course.boxFolderId;
  const lessonIds = new Set(await courseLessonOrder(db, courseId));
  const root = await box.listItems(courseFolderId);
  const languages = (options.languages ?? root.filter((i) => i.type === "folder" && /^[A-Z]{2}$/.test(i.name)).map((i) => i.name.toLowerCase())).map((l) => l.toLowerCase());

  const result: CopyToLessonFoldersResult = { courseId, counts: { copied: 0, updated: 0, unchanged: 0 }, foldersCreated: 0, nothingToCopy: {}, errors: [], done: true };
  const pastDeadline = () => options.deadline !== undefined && Date.now() > options.deadline;

  // Lesson folders are created up front, one at a time, so parallel languages never race to create the same one.
  const rootFolders = new Set(root.filter((i) => i.type === "folder").map((i) => i.name));

  for (const language of languages) {
    const name = languageName(language);
    const langFolder = root.find((i) => i.type === "folder" && i.name === languageFolder(language));
    if (!langFolder) {
      result.errors.push({ language, lessonId: "", error: `No ${languageFolder(language)} folder in the course's Box folder` });
      continue;
    }
    // Only real lessons of the course — never sibling folders like "Quiz Questions".
    const sources = (await box.listItems(langFolder.id)).filter((i) => i.type === "folder" && lessonIds.has(i.name));
    const present = new Set(sources.map((s) => s.name));
    result.nothingToCopy[language] = [...lessonIds].filter((id) => !present.has(id));

    const copyLesson = async (lesson: StoredItem) => {
      const items = await box.listItems(lesson.id);
      const files: { source: StoredItem; destPath: string[] }[] = [];
      const segments = items.find((i) => i.type === "file" && i.name === segmentsFileName({ lessonId: lesson.name, language }));
      if (segments) files.push({ source: segments, destPath: [lesson.name] });
      const clips = items.find((i) => i.type === "folder" && i.name === `${name} Clips`);
      if (clips) {
        for (const f of (await box.listItems(clips.id)).filter((i) => i.type === "file")) files.push({ source: f, destPath: [lesson.name, `${name} Clips`] });
      }
      if (!files.length) return;
      if (!rootFolders.has(lesson.name)) {
        rootFolders.add(lesson.name);
        result.foldersCreated++;
      }
      const folderIds = new Map<string, string>();
      for (const f of files) {
        const key = f.destPath.join("/");
        if (!folderIds.has(key)) folderIds.set(key, await box.ensureFolderPath(courseFolderId, f.destPath));
      }
      await inParallel(files, 3, async (f) => {
        try {
          const { outcome } = await withRetry(() => box.copyFile(f.source, folderIds.get(f.destPath.join("/"))!));
          result.counts[outcome]++;
        } catch (err) {
          result.errors.push({ language, lessonId: lesson.name, file: f.source.name, error: err instanceof Error ? err.message : String(err) });
        }
      });
      options.onLesson?.(language, lesson.name, files.length);
    };

    await inParallel(sources, options.concurrency ?? 3, async (lesson) => {
      if (pastDeadline()) {
        result.done = false;
        return;
      }
      await copyLesson(lesson);
    });
    if (!result.done) break;
  }
  return result;
}

async function inParallel<T>(items: T[], limit: number, work: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (next < items.length) await work(items[next++]);
    })
  );
}

/** Box answers 429 when copies come too fast — wait and try again (up to 4 times). */
async function withRetry<T>(fn: () => Promise<T>): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await fn();
    } catch (err) {
      const rateLimited = err instanceof Error && /^429\b|rate limit/i.test(err.message);
      if (!rateLimited || attempt >= 4) throw err;
      await new Promise((r) => setTimeout(r, 2000 * 2 ** attempt));
    }
  }
}
