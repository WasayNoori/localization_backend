// src/interfaces/ICourseAuditCheck.ts
// A course-level check the audit runs besides the per-lesson audio checks
// (e.g. the outline is translated, the quiz workbook is in Box). Modules add
// their own to `app.courseAuditChecks`, so the audit doesn't import them.
import type { Database } from "../db/client.js";
import type { IFileStorageService } from "./IFileStorageService.js";

export interface CourseAuditContext {
  db: Database;
  fileStorageService: IFileStorageService;
  course: { id: string; boxFolderId: string; mondayBoardId: string | null };
  language: string;
}

export interface CourseAuditFindings {
  /** Fail the audit. */
  problems: string[];
  /** Worth a look, don't fail it. */
  warnings: string[];
}

export interface ICourseAuditCheck {
  /** Shown before each finding, e.g. "Outline". */
  readonly name: string;
  check(context: CourseAuditContext): Promise<CourseAuditFindings>;
}
