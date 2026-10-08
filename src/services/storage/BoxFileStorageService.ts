// src/services/storage/BoxFileStorageService.ts
import { createHash } from "node:crypto";
import { BoxCcgAuth, BoxClient, BoxDeveloperTokenAuth, CcgConfig } from "box-typescript-sdk-gen";
import { generateByteStreamFromBuffer, readByteStream } from "box-typescript-sdk-gen/internal";
import type { IFileStorageService, SaveAudioResult, StorageAccount, StoredItem } from "../../interfaces/IFileStorageService.js";
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

type FolderEntry = { id: string; type: string; sha1?: string };

export class BoxFileStorageService implements IFileStorageService {
  private clientPromise: Promise<BoxClient> | undefined;
  /** Folder id → its children by name. Filled on first look, updated on every create/upload. */
  private readonly folderCache = new Map<string, Promise<Map<string, FolderEntry>>>();

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
    const { fileId, filePath } = await this.saveFile(folderId, `${requestId}.mp3`, audio);
    return { fileId, filePath };
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

  async ensureFolderPath(rootFolderId: string, path: string[]): Promise<string> {
    let folderId = rootFolderId;
    for (const name of path) folderId = await this.ensureChildFolder(folderId, name);
    return folderId;
  }

  async saveFile(folderId: string, fileName: string, content: Buffer): Promise<SaveAudioResult & { unchanged: boolean }> {
    const client = await this.getClient();
    const children = await this.children(folderId);
    const existing = children.get(fileName);
    const sha1 = createHash("sha1").update(content).digest("hex");
    const filePath = `${folderId}/${fileName}`;

    if (existing?.type === "file" && existing.sha1 === sha1) {
      return { fileId: existing.id, filePath, unchanged: true };
    }

    // Same name → new version of that file (keeps its id and history), not a conflict.
    const result = existing?.type === "file"
      ? await client.uploads.uploadFileVersion(existing.id, {
          attributes: { name: fileName },
          file: generateByteStreamFromBuffer(content),
        })
      : await client.uploads.uploadFile({
          attributes: { name: fileName, parent: { id: folderId } },
          file: generateByteStreamFromBuffer(content),
          fileFileName: fileName,
        });

    const uploaded = result.entries?.[0];
    if (!uploaded?.id) throw new Error(`Box upload of "${fileName}" returned no file id`);
    children.set(fileName, { id: uploaded.id, type: "file", sha1 });
    return { fileId: uploaded.id, filePath, unchanged: false };
  }

  async whoAmI(): Promise<StorageAccount> {
    const client = await this.getClient();
    const me = await client.users.getUserMe();
    return { id: me.id, name: me.name ?? "", login: me.login ?? "" };
  }

  async findFolderPath(rootFolderId: string, path: string[]): Promise<string | null> {
    let id = rootFolderId;
    for (const name of path) {
      const found = (await this.listFolder(id)).get(name);
      if (found?.type !== "folder") return null;
      id = found.id;
    }
    return id;
  }

  async listItems(folderId: string): Promise<StoredItem[]> {
    return [...(await this.listFolder(folderId))].map(([name, e]) => ({ id: e.id, name, type: e.type }));
  }

  private async ensureChildFolder(parentId: string, name: string): Promise<string> {
    const children = await this.children(parentId);
    const existing = children.get(name);
    if (existing) {
      if (existing.type !== "folder") throw new Error(`"${name}" in Box folder ${parentId} is a ${existing.type}, not a folder`);
      return existing.id;
    }
    const client = await this.getClient();
    try {
      const created = await client.folders.createFolder({ name, parent: { id: parentId } });
      children.set(name, { id: created.id, type: "folder" });
      return created.id;
    } catch (err) {
      // Created by someone else since we listed — re-read and use theirs.
      if (getBoxApiErrorStatusCode(err) !== 409) throw err;
      this.folderCache.delete(parentId);
      const found = (await this.children(parentId)).get(name);
      if (found?.type !== "folder") throw err;
      return found.id;
    }
  }

  /** The folder's items by name (paged), cached for the life of this service. */
  private children(folderId: string): Promise<Map<string, FolderEntry>> {
    let cached = this.folderCache.get(folderId);
    if (!cached) {
      cached = this.listFolder(folderId).catch((err) => {
        this.folderCache.delete(folderId);
        throw err;
      });
      this.folderCache.set(folderId, cached);
    }
    return cached;
  }

  private async listFolder(folderId: string): Promise<Map<string, FolderEntry>> {
    const client = await this.getClient();
    const byName = new Map<string, FolderEntry>();
    let marker: string | undefined;
    do {
      const page = await client.folders.getFolderItems(folderId, {
        queryParams: { fields: ["name", "type", "sha1"], usemarker: true, limit: 1000, ...(marker ? { marker } : {}) },
      });
      for (const e of page.entries ?? []) {
        const item = e as { id: string; type: string; name?: string; sha1?: string };
        if (item.name) byName.set(item.name, { id: item.id, type: item.type, sha1: item.sha1 });
      }
      marker = page.nextMarker ?? undefined;
    } while (marker);
    return byName;
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

  // The Box app's client-credentials login (long-lived; acts as the app's
  // service account). Falls back to a developer token (~1 hour, local testing
  // only) when the app's secrets aren't configured.
  private async buildClient(): Promise<BoxClient> {
    const [clientId, clientSecret, enterpriseId] = await Promise.all(
      ["box-client-id", "box-client-secret", "box-enterprise-id"].map((n) => this.optionalSecret(n))
    );
    if (clientId && clientSecret && enterpriseId) {
      return new BoxClient({ auth: new BoxCcgAuth({ config: new CcgConfig({ clientId, clientSecret, enterpriseId }) }) });
    }
    const token = await this.optionalSecret("box-dev-token");
    if (!token) {
      throw new Error("Box isn't configured: set box-client-id, box-client-secret and box-enterprise-id (or box-dev-token for testing)");
    }
    return new BoxClient({ auth: new BoxDeveloperTokenAuth({ token }) });
  }

  private async optionalSecret(name: string): Promise<string | undefined> {
    try {
      return (await this.secretsProvider.getSecret(name)) || undefined;
    } catch {
      return undefined;
    }
  }
}
