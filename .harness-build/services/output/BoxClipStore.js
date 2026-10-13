import { clipFileName, clipsDirInCourse } from "./outputLayout.js";
/**
 * Saves clips to Box under the course's folder, in the same layout as the
 * local folder: <course folder>/<LANG>/<lessonId>/<Language> Clips/<lessonId>_<lang>_NNN.mp3.
 * Folders are created as needed; a regenerated clip becomes a new version of
 * the same Box file. `destination.boxFolderId` is the course's top-level folder.
 */
export class BoxClipStore {
    fileStorage;
    constructor(fileStorage) {
        this.fileStorage = fileStorage;
    }
    async save(destination, audio) {
        if (!destination.boxFolderId)
            throw new Error("The course has no Box folder — set it on the course page");
        const dir = clipsDirInCourse(destination);
        const name = clipFileName(destination, destination.segmentNumber);
        const folderId = await this.fileStorage.ensureFolderPath(destination.boxFolderId, dir);
        const saved = await this.fileStorage.saveFile(folderId, name, audio);
        return { boxFileId: saved.fileId, boxFilePath: [...dir, name].join("/"), localPath: null };
    }
}
//# sourceMappingURL=BoxClipStore.js.map