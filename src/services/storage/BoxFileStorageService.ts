// src/services/storage/BoxFileStorageService.ts
import { promises as fs } from "fs";
import path from "path";
import { BoxClient, BoxCcgAuth, CcgConfig } from "box-typescript-sdk-gen";
import { readByteStream } from "box-typescript-sdk-gen/internal";
import type { IFileStorageService, SaveAudioResult } from "../../interfaces/IFileStorageService.js";
import type { ISecretsProvider } from "../../interfaces/ISecretsProvider.js";

const LOCAL_OUTPUT_DIR = "C:\\Dev_Sandbox\\ElevenLabsAPI";

export class BoxFileStorageService implements IFileStorageService {
  private clientPromise: Promise<BoxClient> | undefined;

  constructor(private readonly secretsProvider: ISecretsProvider) {}

  async getFileContent(fileId: string): Promise<Buffer> {
    const client = await this.getClient();
    const stream = await client.downloads.downloadFile(fileId);

    if (!stream) {
      throw new Error(`Box file "${fileId}" returned no content`);
    }

    return readByteStream(stream);
  }

  // Upload side still writes locally — real Box upload is generate-stage
  // work, not yet built. Read (getFileContent) and write are on separate
  // tracks for now.
  async saveAudio(audio: Buffer, requestId: string): Promise<SaveAudioResult> {
    await fs.mkdir(LOCAL_OUTPUT_DIR, { recursive: true });

    const filePath = path.join(LOCAL_OUTPUT_DIR, `${requestId}.mp3`);
    await fs.writeFile(filePath, audio);

    return { filePath };
  }

  private getClient(): Promise<BoxClient> {
    if (!this.clientPromise) {
      this.clientPromise = this.buildClient().catch((err) => {
        this.clientPromise = undefined;
        throw err;
      });
    }
    return this.clientPromise;
  }

  private async buildClient(): Promise<BoxClient> {
    const [clientId, clientSecret, enterpriseId] = await Promise.all([
      this.secretsProvider.getSecret("box-client-id"),
      this.secretsProvider.getSecret("box-client-secret"),
      this.secretsProvider.getSecret("box-enterprise-id"),
    ]);

    const auth = new BoxCcgAuth({
      config: new CcgConfig({ clientId, clientSecret, enterpriseId }),
    });

    return new BoxClient({ auth });
  }
}