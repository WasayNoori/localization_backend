// src/modules/quiz/QuizWorkbookAuditCheck.ts
// Adds "the quiz is translated" to the course audit: the module stores nothing
// about quizzes, so done = its workbook is in Box.
import type { CourseAuditContext, CourseAuditFindings, ICourseAuditCheck } from "../../interfaces/ICourseAuditCheck.js";
import { quizFileName, quizFolderPath } from "./BoxQuizWorkbookStore.js";

export class QuizWorkbookAuditCheck implements ICourseAuditCheck {
  readonly name = "Quiz";

  async check({ fileStorageService: box, course, language }: CourseAuditContext): Promise<CourseAuditFindings> {
    const findings: CourseAuditFindings = { problems: [], warnings: [] };
    if (language === "en") return findings;
    const path = quizFolderPath(language);
    const name = quizFileName(course.id, language);
    const folderId = await box.findFolderPath(course.boxFolderId, path);
    const inBox = folderId ? (await box.listItems(folderId)).some((i) => i.type === "file" && i.name === name) : false;
    if (inBox) return findings;
    findings.problems.push(
      course.mondayBoardId
        ? `${[...path, name].join("/")} not in Box — translate the quiz on the course page`
        : `not translated, and the course has no monday.com board set (the quiz source)`
    );
    return findings;
  }
}
