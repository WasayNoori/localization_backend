// src/services/output/BoxLessonOutputStore.ts
import type { IFileStorageService } from "../../interfaces/IFileStorageService.js";
import type { ILessonOutputStore, LessonOutputTarget } from "../../interfaces/ILessonOutputStore.js";
import { clipFileName, clipsDirInCourse, lessonDirInCourse, segmentsFileName } from "./outputLayout.js";

/**
 * Lesson outputs in one course's Box folder — the same layout as the local
 * folder, rooted at the course folder (so `target.courseFolder` isn't used).
 * Unchanged files aren't re-uploaded; changed ones become new versions.
 */
export class BoxLessonOutputStore implements ILessonOutputStore {
  constructor(
    private readonly fileStorage: IFileStorageService,
    private readonly courseFolderId: string
  ) {}

  writeSegmentsFile(target: LessonOutputTarget, content: string): Promise<string> {
    return this.write(lessonDirInCourse(target), segmentsFileName(target), Buffer.from(content, "utf8"));
  }

  writeClip(target: LessonOutputTarget, segmentNumber: number, audio: Buffer): Promise<string> {
    return this.write(clipsDirInCourse(target), clipFileName(target, segmentNumber), audio);
  }

  private async write(dir: string[], name: string, content: Buffer): Promise<string> {
    const folderId = await this.fileStorage.ensureFolderPath(this.courseFolderId, dir);
    await this.fileStorage.saveFile(folderId, name, content);
    return ["Box", ...dir, name].join("/");
  }
}
