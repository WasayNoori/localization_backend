// src/services/output/LocalFolderLessonOutputStore.ts
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join, resolve, sep } from "node:path";
import { clipFilePath, segmentsFilePath } from "./outputLayout.js";
/** Writes lesson outputs under a local root folder (LOCAL_OUTPUT_ROOT), in the course folder layout. */
export class LocalFolderLessonOutputStore {
    root;
    constructor(rootDir) {
        this.root = resolve(rootDir);
    }
    writeSegmentsFile(target, content) {
        return this.write(segmentsFilePath(target), content);
    }
    writeClip(target, segmentNumber, audio) {
        return this.write(clipFilePath(target, segmentNumber), audio);
    }
    async write(parts, data) {
        const path = resolve(join(this.root, ...parts));
        if (!path.startsWith(this.root + sep))
            throw new Error(`Refusing to write outside the output root: ${path}`);
        await mkdir(dirname(path), { recursive: true });
        await writeFile(path, data);
        return path;
    }
}
//# sourceMappingURL=LocalFolderLessonOutputStore.js.map