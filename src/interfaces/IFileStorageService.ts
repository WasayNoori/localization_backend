// src/interfaces/IFileStorageService.ts
export interface SaveAudioResult {
  fileId: string;
  filePath: string;
}

export interface StorageAccount {
  id: string;
  name: string;
  /** For Box's client-credentials login this is the app's service account email — add it as a collaborator on course folders. */
  login: string;
}

/** A file or folder as storage lists it. */
export interface StoredItem {
  id: string;
  name: string;
  type: string; // "file" | "folder" (Box also has "web_link")
}

export interface IFileStorageService {
  /** Legacy flat upload (one folder, file named by request id). Prefer ensureFolderPath + saveFile. */
  saveAudio(audio: Buffer, requestId: string, folderId: string): Promise<SaveAudioResult>;
  getFileContent(fileId: string): Promise<Buffer>;
  /** Whether a previously-uploaded file still exists in storage. */
  fileExists(fileId: string): Promise<boolean>;
  /** Finds each folder of `path` under `rootFolderId`, creating what's missing; returns the last folder's id. */
  ensureFolderPath(rootFolderId: string, path: string[]): Promise<string>;
  /**
   * Saves `content` as `fileName` in the folder. A file with that name already
   * there gets a new version (same file id); identical content is left as is.
   */
  saveFile(folderId: string, fileName: string, content: Buffer): Promise<SaveAudioResult & { unchanged: boolean }>;
  /** The folder at `path` under `rootFolderId`, read fresh (no cache, creates nothing); null when any part is missing. */
  findFolderPath(rootFolderId: string, path: string[]): Promise<string | null>;
  /** The folder's items, read fresh from storage — for audits, which must see what's really there. */
  listItems(folderId: string): Promise<StoredItem[]>;
  /** The account the app is signed in as — a connectivity check. */
  whoAmI(): Promise<StorageAccount>;
}
