// src/services/output/LocalFolderClipStore.ts
import type { ClipDestination, IClipStore, StoredClip } from "../../interfaces/IClipStore.js";
import type { ILessonOutputStore } from "../../interfaces/ILessonOutputStore.js";

/**
 * POC: saves clips into the local course folder layout
 * (<courseFolder>/<Language>/<lessonId>/<Language> Clips/<lessonId>_<lang>_NNN.mp3)
 * until the Box app is registered. box_file_id stays null; local_path is
 * what a later Box upload backfills from.
 */
export class LocalFolderClipStore implements IClipStore {
  constructor(private readonly outputStore: ILessonOutputStore) {}

  async save(destination: ClipDestination, audio: Buffer): Promise<StoredClip> {
    if (!destination.courseFolder) throw new Error("No course folder to save the clip into");
    const localPath = await this.outputStore.writeClip(
      { courseFolder: destination.courseFolder, language: destination.language, lessonId: destination.lessonId },
      destination.segmentNumber,
      audio
    );
    return { boxFileId: null, boxFilePath: null, localPath };
  }
}
