// src/interfaces/IClipStore.ts

/** Everything a store might need to place one generated clip. */
export interface ClipDestination {
  lessonId: string;
  language: string;
  /** 1-based position in the lesson's segment order — matches "<Language> Segments.txt" (001, 002…). */
  segmentNumber: number;
  /** ElevenLabs request id of the synthesis call that produced the audio. */
  requestId: string;
  /** Box folder (Box store). Null when clips aren't going to Box. */
  boxFolderId: string | null;
  /** Course folder relative to the local output root (local store). Null when clips aren't stored locally. */
  courseFolder: string | null;
}

/** Where the clip ended up — the store fills in what applies to it; the rest stays null. */
export interface StoredClip {
  boxFileId: string | null;
  boxFilePath: string | null;
  localPath: string | null;
}

/**
 * Where generated audio clips are saved. Box is the normal destination
 * (BoxClipStore); LocalFolderClipStore is the POC path until the Box app is
 * registered — clips land in the course folder layout on disk, and
 * tts_clips.local_path lets a later backfill fill in box_file_id.
 */
export interface IClipStore {
  save(destination: ClipDestination, audio: Buffer): Promise<StoredClip>;
}
