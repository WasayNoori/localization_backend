// src/services/storage/BoxFileStorageService.ts
import { promises as fs } from "fs";
import path from "path";
import type { IFileStorageService, SaveAudioResult } from "../../interfaces/IFileStorageService.js";

const LOCAL_OUTPUT_DIR = "C:\\Dev_Sandbox\\ElevenLabsAPI";

export class BoxFileStorageService implements IFileStorageService {
  async saveAudio(audio: Buffer, requestId: string): Promise<SaveAudioResult> {
    await fs.mkdir(LOCAL_OUTPUT_DIR, { recursive: true });

    const filePath = path.join(LOCAL_OUTPUT_DIR, `${requestId}.mp3`);
    await fs.writeFile(filePath, audio);

    return { filePath };
  }
}