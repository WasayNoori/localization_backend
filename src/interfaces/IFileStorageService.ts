// src/interfaces/IFileStorageService.ts
export interface SaveAudioResult {
  filePath: string;
}

export interface IFileStorageService {
  saveAudio(audio: Buffer, requestId: string): Promise<SaveAudioResult>;
}