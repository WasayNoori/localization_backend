// src/services/audit/OutlineAuditCheck.ts
import ExcelJS from "exceljs";
import type { CourseAuditContext, CourseAuditFindings, ICourseAuditCheck } from "../../interfaces/ICourseAuditCheck.js";
import { getCourseStructure, type CourseStructureLesson } from "../catalog/getCourseStructure.js";
import { languageFolder, outlineFileName } from "../output/outputLayout.js";

/**
 * Translated languages only (English is the source): every outline item —
 * course name and description, section titles, lesson names and
 * descriptions — has a current translation (not stale), and the outline
 * workbook <LANG>/<courseId> Outline <LANG>.xlsx is in Box — and was saved
 * after the translation: a workbook still showing English (its "not
 * translated yet" note) fails too.
 */
export class OutlineAuditCheck implements ICourseAuditCheck {
  readonly name = "Outline";

  async check({ db, fileStorageService: box, course, language }: CourseAuditContext): Promise<CourseAuditFindings> {
    const findings: CourseAuditFindings = { problems: [], warnings: [] };
    if (language === "en") return findings;
    const structure = await getCourseStructure(db, course.id);
    if (!structure) return findings;

    const missing: string[] = [];
    const stale: string[] = [];
    const tally = (label: string, t: { stale: boolean } | undefined, needsDescription = false, description?: string | null) => {
      if (!t || (needsDescription && !description)) missing.push(label);
      else if (t.stale) stale.push(label);
    };
    const ct = structure.translations.find((t) => t.language === language);
    tally("course name", ct);
    if (structure.description) tally("course description", ct, true, ct?.description);
    for (const s of structure.sections) tally(`section ${s.sectionIndex} title`, s.translations.find((t) => t.language === language));
    const lessons: CourseStructureLesson[] = [...structure.sections.flatMap((s) => s.lessons), ...structure.unsectionedLessons];
    for (const l of lessons) {
      const t = l.translations.find((x) => x.language === language);
      tally(`${l.id} name`, t);
      if (l.description) tally(`${l.id} description`, t, true, t?.description);
    }
    if (missing.length) findings.problems.push(`${missing.length} item(s) not translated: ${list(missing)}`);
    if (stale.length) findings.problems.push(`${stale.length} item(s) outdated (English changed since): ${list(stale)}`);

    const folderId = await box.findFolderPath(course.boxFolderId, [languageFolder(language)]);
    const name = outlineFileName(course.id, language);
    const file = folderId ? (await box.listItems(folderId)).find((i) => i.type === "file" && i.name === name) : undefined;
    if (!file) {
      findings.problems.push(`${languageFolder(language)}/${name} not in Box — use "Excel to Box" on the course page`);
      return findings;
    }
    const english = await untranslatedNote(await box.getFileContent(file.id));
    if (english) {
      findings.problems.push(`${languageFolder(language)}/${name} in Box still shows English (${english}) — it was saved before the outline was translated; use "Excel to Box" again`);
    }
    return findings;
  }
}

function list(items: string[], max = 8): string {
  return items.length > max ? `${items.slice(0, max).join(", ")} and ${items.length - max} more` : items.join(", ");
}

/** The workbook's own note on English fallback cells ("Red italic = not translated yet (12 cell(s)) …"), or null. */
async function untranslatedNote(content: Buffer): Promise<string | null> {
  const wb = new ExcelJS.Workbook();
  try {
    await wb.xlsx.load(content as unknown as ArrayBuffer);
  } catch {
    return "the file couldn't be read";
  }
  const sheet = wb.getWorksheet("Outline");
  if (!sheet) return null;
  let note: string | null = null;
  sheet.eachRow((row) => {
    const v = row.getCell(1).value;
    if (typeof v === "string" && v.startsWith("Red italic = not translated yet")) note = v.match(/\((\d+) cell/)?.[1] ? `${v.match(/\((\d+) cell/)![1]} cells` : "some cells";
  });
  return note;
}
