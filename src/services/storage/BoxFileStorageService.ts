// src/services/storage/BoxFileStorageService.ts
import { BoxClient, BoxDeveloperTokenAuth } from "box-typescript-sdk-gen";
import { generateByteStreamFromBuffer, readByteStream } from "box-typescript-sdk-gen/internal";
import type { IFileStorageService, SaveAudioResult } from "../../interfaces/IFileStorageService.js";
import type { ISecretsProvider } from "../../interfaces/ISecretsProvider.js";

// BoxApiError isn't part of box-typescript-sdk-gen's public export surface
// (no subpath re-exports it), so this checks the error structurally instead
// of importing the class. Also: despite the type declarations promising
// `responseInfo.statusCode`, that field is actually undefined on every
// BoxApiError in this SDK version (verified against both a real 404 and a
// trashed-file 404) — the only reliable signal is the leading HTTP status
// in `.message` (e.g. `404 "Not Found"; Request ID: "..."`). BoxSdkError
// (auth/network-level failures, e.g. an expired dev token) never has this
// numeric prefix, so this can't mistake those for a missing file.
function getBoxApiErrorStatusCode(err: unknown): number | undefined {
  if (!(err instanceof Error) || err.constructor.name !== "BoxApiError") {
    return undefined;
  }
  const match = /^(\d{3})\b/.exec(err.message);
  return match ? Number(match[1]) : undefined;
}

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

  async saveAudio(audio: Buffer, requestId: string, folderId: string): Promise<SaveAudioResult> {
    const client = await this.getClient();
    const fileName = `${requestId}.mp3`;

    const result = await client.uploads.uploadFile({
      attributes: { name: fileName, parent: { id: folderId } },
      file: generateByteStreamFromBuffer(audio),
      fileFileName: fileName,
    });

    const uploaded = result.entries?.[0];
    if (!uploaded?.id) {
      throw new Error(`Box upload of "${fileName}" returned no file id`);
    }

    return { fileId: uploaded.id, filePath: `${folderId}/${uploaded.name ?? fileName}` };
  }

  async fileExists(fileId: string): Promise<boolean> {
    const client = await this.getClient();

    try {
      await client.files.getFileById(fileId);
      return true;
    } catch (err) {
      // A genuine 404 (BoxApiError) means the file is gone — anything else
      // (expired token, network blip, permissions) must rethrow rather than
      // be mistaken for "missing," or we'd wrongly trigger regeneration.
      // Also covers a trashed (soft-deleted) file — Box returns 404 for that
      // too ("Item is trashed"), which is exactly what we want treated as gone.
      if (getBoxApiErrorStatusCode(err) === 404) {
        return false;
      }
      throw err;
    }
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

  // Developer Token auth for now (short-lived, ~1hr — from the Box dev
  // console, meant for local testing only). Client-credentials (BoxCcgAuth)
  // is the intended long-lived auth for a real deployment; swap this back
  // in once that's actually needed and validated.
  private async buildClient(): Promise<BoxClient> {
    const token = await this.secretsProvider.getSecret("box-dev-token");
    const auth = new BoxDeveloperTokenAuth({ token });

    return new BoxClient({ auth });
  }
}