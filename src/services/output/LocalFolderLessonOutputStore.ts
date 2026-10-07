// src/services/output/LocalFolderLessonOutputStore.ts
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join, resolve, sep } from "node:path";
import type { ILessonOutputStore, LessonOutputTarget } from "../../interfaces/ILessonOutputStore.js";
import { clipFilePath, segmentsFilePath } from "./outputLayout.js";

/** Writes lesson outputs under a local root folder (LOCAL_OUTPUT_ROOT), in the course folder layout. */
export class LocalFolderLessonOutputStore implements ILessonOutputStore {
  private readonly root: string;

  constructor(rootDir: string) {
    this.root = resolve(rootDir);
  }

  writeSegmentsFile(target: LessonOutputTarget, content: string): Promise<string> {
    return this.write(segmentsFilePath(target), content);
  }

  writeClip(target: LessonOutputTarget, segmentNumber: number, audio: Buffer): Promise<string> {
    return this.write(clipFilePath(target, segmentNumber), audio);
  }

  private async write(parts: string[], data: string | Buffer): Promise<string> {
    const path = resolve(join(this.root, ...parts));
    if (!path.startsWith(this.root + sep)) throw new Error(`Refusing to write outside the output root: ${path}`);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, data);
    return path;
  }
}
