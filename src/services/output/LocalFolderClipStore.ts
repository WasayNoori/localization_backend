// src/services/output/LocalFolderClipStore.ts
import type { ClipDestination, IClipStore, StoredClip } from "../../interfaces/IClipStore.js";
import type { ILessonOutputStore } from "../../interfaces/ILessonOutputStore.js";
import { clipFilePath } from "./outputLayout.js";

/**
 * POC: saves clips into the local course folder layout
 * (<courseFolder>/<LANG>/<lessonId>/<Language> Clips/<lessonId>_<lang>_NNN.mp3)
 * until the Box app is registered. box_file_id stays null; local_path is
 * what a later Box upload backfills from — stored relative to the output
 * root ("SOLIDWORKS Simulation/FR/25Sim01_01/French Clips/25Sim01_01_fr_001.mp3"),
 * so it reads the same whichever machine or shell ran the generation.
 */
export class LocalFolderClipStore implements IClipStore {
  constructor(private readonly outputStore: ILessonOutputStore) {}

  async save(destination: ClipDestination, audio: Buffer): Promise<StoredClip> {
    if (!destination.courseFolder) throw new Error("No course folder to save the clip into");
    const target = { courseFolder: destination.courseFolder, language: destination.language, lessonId: destination.lessonId };
    await this.outputStore.writeClip(target, destination.segmentNumber, audio);
    return { boxFileId: null, boxFilePath: null, localPath: clipFilePath(target, destination.segmentNumber).join("/") };
  }
}
