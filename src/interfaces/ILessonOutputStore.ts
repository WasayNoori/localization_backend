// src/interfaces/ILessonOutputStore.ts

/** Which lesson + language an output belongs to. `courseFolder` is relative to the store's root. */
export interface LessonOutputTarget {
  courseFolder: string;
  language: string;
  lessonId: string;
}

/**
 * Where finished lesson outputs go, in the course folder layout:
 *   <courseFolder>/<LANG>/<lessonId>/<Language> Segments.txt
 *   <courseFolder>/<LANG>/<lessonId>/<Language> Clips/<lessonId>_<lang>_<NNN>.mp3
 * A local folder for now (LocalFolderLessonOutputStore); Box later, same layout.
 */
export interface ILessonOutputStore {
  /** Writes (replaces) the lesson's segments file. Returns where it was written. */
  writeSegmentsFile(target: LessonOutputTarget, content: string): Promise<string>;
  /** Writes (replaces) one audio clip; `segmentNumber` is 1-based, matching the segments file. */
  writeClip(target: LessonOutputTarget, segmentNumber: number, audio: Buffer): Promise<string>;
}
