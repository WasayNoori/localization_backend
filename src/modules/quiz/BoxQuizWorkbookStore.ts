// src/modules/quiz/BoxQuizWorkbookStore.ts
import ExcelJS from "exceljs";
import { languageName } from "../../config/languages.js";
import type { IFileStorageService } from "../../interfaces/IFileStorageService.js";
import { QuizSourceError, type IQuizOutputStore, type QuizOutput } from "./interfaces.js";
import { ANSWER_LETTERS } from "./quizTypes.js";

/** Box folder under the course folder: <LANG>/Quiz Questions — next to the lesson folders. */
export const quizFolderPath = (language: string): string[] => [language.toUpperCase(), "Quiz Questions"];
export const quizFileName = (courseId: string, language: string): string => `${courseId} Quiz Questions ${language.toUpperCase()}.xlsx`;

const FONT = "Arial";
const HEADER_FILL = "FF1F3864";
const FLAG_FILL = "FFFCE4D6";

/**
 * One .xlsx per language in the course's Box folder, replacing the previous
 * one (Box keeps earlier versions). One row per question in source order;
 * English beside each translation so a reviewer can compare.
 */
export class BoxQuizWorkbookStore implements IQuizOutputStore {
  constructor(private readonly fileStorage: IFileStorageService) {}

  async write(output: QuizOutput): Promise<{ fileId: string; path: string }> {
    const { course, language } = output;
    if (!course.boxFolderId) throw new QuizSourceError(`Course "${course.id}" has no Box folder — set it on the course's Edit details page`);
    const buffer = await buildQuizWorkbook(output);
    const folderPath = quizFolderPath(language);
    const folderId = await this.fileStorage.ensureFolderPath(course.boxFolderId, folderPath);
    const name = quizFileName(course.id, language);
    const saved = await this.fileStorage.saveFile(folderId, name, buffer);
    return { fileId: saved.fileId, path: [...folderPath, name].join("/") };
  }
}

/** The workbook itself — separate from storage so it can be tested and reused. */
export async function buildQuizWorkbook(output: QuizOutput): Promise<Buffer> {
  const { course, language, questions } = output;
  const LANG = language.toUpperCase();
  const wb = new ExcelJS.Workbook();

  const ws = wb.addWorksheet(`Quiz Questions ${LANG}`, { views: [{ state: "frozen", xSplit: 2, ySplit: 1 }] });
  const columns: { header: string; width: number; key: string }[] = [
    { header: "Lesson ID", width: 18, key: "lesson" },
    { header: "QQ ID", width: 9, key: "qq" },
    { header: "Review Status", width: 14, key: "status" },
    { header: "Correct Answer", width: 10, key: "correct" },
    { header: `Question (${LANG})`, width: 55, key: "q" },
    ...ANSWER_LETTERS.map((l) => ({ header: `${l} (${LANG})`, width: 28, key: `a${l}` })),
    { header: "Question (EN)", width: 55, key: "qEn" },
    ...ANSWER_LETTERS.map((l) => ({ header: `${l} (EN)`, width: 28, key: `a${l}En` })),
    { header: "Image URL", width: 40, key: "image" },
    { header: "Review Flag", width: 45, key: "flags" },
  ];
  ws.columns = columns.map(({ header, width, key }) => ({ header, width, key }));

  for (const row of questions) {
    const q = row.source;
    const added = ws.addRow({
      lesson: row.lessonId,
      qq: q.qqId,
      status: q.reviewStatus,
      correct: q.correctAnswer,
      q: row.question,
      ...Object.fromEntries(ANSWER_LETTERS.map((l) => [`a${l}`, row.answers[l]])),
      qEn: q.question,
      ...Object.fromEntries(ANSWER_LETTERS.map((l) => [`a${l}En`, q.answers[l]])),
      image: q.imageUrl,
      flags: row.flags.join("\n") || null,
    });
    added.eachCell({ includeEmpty: true }, (cell) => {
      cell.font = { name: FONT, size: 10 };
      cell.alignment = { wrapText: true, vertical: "top" };
    });
    if (row.flags.length) added.getCell("flags").fill = { type: "pattern", pattern: "solid", fgColor: { argb: FLAG_FILL } };
    added.getCell("correct").alignment = { horizontal: "center", vertical: "top" };
  }

  const header = ws.getRow(1);
  header.eachCell((cell) => {
    cell.font = { name: FONT, size: 10, bold: true, color: { argb: "FFFFFFFF" } };
    cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: HEADER_FILL } };
    cell.alignment = { wrapText: true, vertical: "middle" };
  });
  // English columns in grey so the translated ones stand out.
  for (let c = 6 + ANSWER_LETTERS.length; c < 6 + 2 * ANSWER_LETTERS.length + 1; c++) {
    ws.getColumn(c).eachCell({ includeEmpty: false }, (cell, rowNumber) => {
      if (rowNumber > 1) cell.font = { name: FONT, size: 10, color: { argb: "FF595959" } };
    });
  }
  ws.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: columns.length } };

  const about = wb.addWorksheet("About");
  const info: [string, string | number][] = [
    ["Course", `${course.courseName} (${course.id})`],
    ["Language", `${languageName(language)} (${LANG})`],
    ["Questions", questions.length],
    ["Flagged for review", questions.filter((r) => r.flags.length).length],
    ["Source", output.sourceDescription],
    ["Generated", output.generatedAt.toISOString().slice(0, 16).replace("T", " ") + " UTC"],
    ["", ""],
    ["Notes", "Rows are in the source's order, with every question whatever its Review Status. TRUE/FALSE answers use fixed words. Correct Answer, Image URL and QQ ID are copied unchanged. Re-running replaces this file; Box keeps earlier versions."],
  ];
  about.columns = [{ width: 20 }, { width: 90 }];
  for (const [k, v] of info) {
    const r = about.addRow([k, v]);
    r.getCell(1).font = { name: FONT, size: 10, bold: true };
    r.getCell(2).font = { name: FONT, size: 10 };
    r.getCell(2).alignment = { wrapText: true, vertical: "top" };
  }
  return Buffer.from(await wb.xlsx.writeBuffer());
}
