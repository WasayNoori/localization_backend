// src/interfaces/IFileStorageService.ts
export interface SaveAudioResult {
  fileId: string;
  filePath: string;
}

export interface IFileStorageService {
  saveAudio(audio: Buffer, requestId: string, folderId: string): Promise<SaveAudioResult>;
  getFileContent(fileId: string): Promise<Buffer>;
  /** Whether a previously-uploaded file still exists in storage. */
  fileExists(fileId: string): Promise<boolean>;
}