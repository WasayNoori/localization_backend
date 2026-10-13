import { clipFileName, clipsDirInCourse, lessonDirInCourse, segmentsFileName } from "./outputLayout.js";
/**
 * Lesson outputs in one course's Box folder — the same layout as the local
 * folder, rooted at the course folder (so `target.courseFolder` isn't used).
 * Unchanged files aren't re-uploaded; changed ones become new versions.
 */
export class BoxLessonOutputStore {
    fileStorage;
    courseFolderId;
    constructor(fileStorage, courseFolderId) {
        this.fileStorage = fileStorage;
        this.courseFolderId = courseFolderId;
    }
    writeSegmentsFile(target, content) {
        return this.write(lessonDirInCourse(target), segmentsFileName(target), Buffer.from(content, "utf8"));
    }
    writeClip(target, segmentNumber, audio) {
        return this.write(clipsDirInCourse(target), clipFileName(target, segmentNumber), audio);
    }
    async write(dir, name, content) {
        const folderId = await this.fileStorage.ensureFolderPath(this.courseFolderId, dir);
        await this.fileStorage.saveFile(folderId, name, content);
        return ["Box", ...dir, name].join("/");
    }
}
//# sourceMappingURL=BoxLessonOutputStore.js.map