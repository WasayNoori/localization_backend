// src/services/output/outputLayout.ts
// The course folder layout (mirrors the planned Box structure). One place for
// folder and file names so the local store and a future Box store agree.
import { languageName } from "../../config/languages.js";
import type { LessonOutputTarget } from "../../interfaces/ILessonOutputStore.js";

/** Splits a relative course folder ("A/B" or "A\\B") into parts; rejects absolute paths and "..". */
export function courseFolderParts(courseFolder: string): string[] {
  const parts = courseFolder.split(/[\\/]+/).map((p) => p.trim()).filter(Boolean);
  if (!parts.length) throw new Error("Course folder is empty");
  if (/^[a-zA-Z]:/.test(courseFolder.trim()) || /^[\\/]/.test(courseFolder.trim())) {
    throw new Error(`Course folder must be relative to the output root: "${courseFolder}"`);
  }
  if (parts.some((p) => p === "." || p === "..")) throw new Error(`Course folder can't contain "." or "..": "${courseFolder}"`);
  return parts;
}

/** Everything below the course folder — the same in the local folder and in Box. */
export type LessonInCourse = Pick<LessonOutputTarget, "language" | "lessonId">;

/** e.g. ["French", "25Sim01_01"] */
export const lessonDirInCourse = (t: LessonInCourse): string[] => [languageName(t.language), t.lessonId];

/** e.g. "French Segments.txt" — lives in the lesson folder. */
export const segmentsFileName = (t: LessonInCourse): string => `${languageName(t.language)} Segments.txt`;

/** e.g. ["French", "25Sim01_01", "French Clips"] */
export const clipsDirInCourse = (t: LessonInCourse): string[] => [...lessonDirInCourse(t), `${languageName(t.language)} Clips`];

/** e.g. "25Sim01_01_fr_001.mp3" — numbered like the segments file. */
export const clipFileName = (t: LessonInCourse, segmentNumber: number): string =>
  `${t.lessonId}_${t.language}_${String(segmentNumber).padStart(3, "0")}.mp3`;

/** e.g. ["SOLIDWORKS Simulation", "French", "25Sim01_01", "French Segments.txt"] */
export const segmentsFilePath = (t: LessonOutputTarget): string[] => [
  ...courseFolderParts(t.courseFolder),
  ...lessonDirInCourse(t),
  segmentsFileName(t),
];

/** e.g. [..., "French Clips", "25Sim01_01_fr_001.mp3"] */
export const clipFilePath = (t: LessonOutputTarget, segmentNumber: number): string[] => [
  ...courseFolderParts(t.courseFolder),
  ...clipsDirInCourse(t),
  clipFileName(t, segmentNumber),
];

/** Segments file body: "001", the text, a blank line — numbers match the clip file names. CRLF for Windows editors. */
export function formatSegmentsText(texts: string[]): string {
  return texts.map((text, i) => `${String(i + 1).padStart(3, "0")}\r\n${text}`).join("\r\n\r\n") + "\r\n";
}
