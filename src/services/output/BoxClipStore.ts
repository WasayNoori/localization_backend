// src/services/output/BoxClipStore.ts
import type { ClipDestination, IClipStore, StoredClip } from "../../interfaces/IClipStore.js";
import type { IFileStorageService } from "../../interfaces/IFileStorageService.js";

/** Saves clips to Box through IFileStorageService (the normal destination). */
export class BoxClipStore implements IClipStore {
  constructor(private readonly fileStorage: IFileStorageService) {}

  async save(destination: ClipDestination, audio: Buffer): Promise<StoredClip> {
    if (!destination.boxFolderId) throw new Error("No Box folder to save the clip into");
    const saved = await this.fileStorage.saveAudio(audio, destination.requestId, destination.boxFolderId);
    return { boxFileId: saved.fileId, boxFilePath: saved.filePath, localPath: null };
  }
}
