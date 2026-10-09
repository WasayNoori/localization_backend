// src/modules/monday-outline/readMondayOutline.ts
import { sql } from "drizzle-orm";
import type { Database } from "../../db/client.js";
import { lessons } from "../../db/schema.js";
import type { IMondayBoardReader } from "../../interfaces/IMondayBoardReader.js";
import { cellText, columnIdByTitle } from "../../services/monday/MondayBoardReader.js";
import type { ImportCourseInput, ImportLessonInput } from "../../services/catalog/importCourseStructure.js";

/** Section groups on course boards: "Section 3 - Defeaturing & Geometry Simplification" (dash, en dash or colon). */
const SECTION_GROUP = /^\s*section\s+(\d+)\s*[-–:]\s*(.+?)\s*$/i;

export interface OutlineCourse {
  id: string;
  courseName: string;
  mondayBoardId: string | null;
}

/** What was read and how Monday's names became lesson ids — shown in the preview. */
export interface MondayOutlineReport {
  board: string;
  sections: number;
  lessons: number;
  /** Monday item names stored under a different id (casing). */
  idChanges: { monday: string; lessonId: string; reason: "existing lesson" | "course id prefix" }[];
  /** Item names that don't start with the course id — kept exactly as in Monday. */
  idsNotMatchingCourse: string[];
  /** Groups that aren't sections (e.g. "Quiz Questions"). */
  skippedGroups: string[];
  skippedItems: { name: string; reason: string }[];
}

export class MondayOutlineError extends Error {}

/**
 * Turns the course's Monday board into the structure import's input:
 * groups "Section N - Title" → sections (N = sectionIndex), their items →
 * lessons (item name = lesson id; Lesson Name, Lesson Description, Lesson
 * Level Tags columns, found by title). Other groups are ignored.
 *
 * Lesson ids, since Monday's casing may differ from the course id's:
 *   1. an existing lesson with the same id ignoring case keeps its id (no duplicates);
 *   2. otherwise an id starting with the course id (any casing) gets the course id's casing;
 *   3. otherwise the Monday name is kept as is (reported).
 * Course name, description and status are left as stored.
 */
export async function readMondayOutline(
  deps: { db: Database; monday: IMondayBoardReader },
  course: OutlineCourse
): Promise<{ input: ImportCourseInput; report: MondayOutlineReport }> {
  if (!course.mondayBoardId) throw new MondayOutlineError(`Course "${course.id}" has no Monday board — set it on the course's Edit details page`);
  const board = await deps.monday.readBoard(course.mondayBoardId);
  const col = {
    name: columnIdByTitle(board, "Lesson Name"),
    description: columnIdByTitle(board, "Lesson Description"),
    tags: columnIdByTitle(board, "Lesson Level Tags"),
  };
  if (!col.name) throw new MondayOutlineError(`Monday board "${board.name}" has no "Lesson Name" column`);

  const report: MondayOutlineReport = {
    board: `${board.name} (${board.id})`,
    sections: 0,
    lessons: 0,
    idChanges: [],
    idsNotMatchingCourse: [],
    skippedGroups: [],
    skippedItems: [],
  };

  // Read the section groups.
  const sectionGroups: { index: number; title: string; items: Awaited<ReturnType<IMondayBoardReader["readGroupItems"]>> }[] = [];
  for (const group of board.groups) {
    const m = SECTION_GROUP.exec(group.title);
    if (!m) {
      report.skippedGroups.push(group.title);
      continue;
    }
    sectionGroups.push({ index: Number(m[1]), title: m[2], items: await deps.monday.readGroupItems(board.id, group.id) });
  }

  // Existing lessons that match any Monday name ignoring case keep their stored id.
  const names = sectionGroups.flatMap((g) => g.items.map((i) => i.name.trim())).filter(Boolean);
  const lowered = [...new Set(names.map((n) => n.toLowerCase()))];
  const existing = lowered.length
    ? await deps.db.select({ id: lessons.id }).from(lessons).where(sql`lower(${lessons.id}) in ${lowered}`)
    : [];
  const existingByLower = new Map(existing.map((l) => [l.id.toLowerCase(), l.id]));
  const prefix = course.id.toLowerCase();

  const lessonIdFor = (name: string): string => {
    const found = existingByLower.get(name.toLowerCase());
    if (found) {
      if (found !== name) report.idChanges.push({ monday: name, lessonId: found, reason: "existing lesson" });
      return found;
    }
    if (name.toLowerCase().startsWith(prefix)) {
      const id = course.id + name.slice(course.id.length);
      if (id !== name) report.idChanges.push({ monday: name, lessonId: id, reason: "course id prefix" });
      return id;
    }
    report.idsNotMatchingCourse.push(name);
    return name;
  };

  const sections: ImportCourseInput["sections"] = sectionGroups
    .sort((a, b) => a.index - b.index)
    .map((g) => {
      const sectionLessons: ImportLessonInput[] = [];
      for (const item of g.items) {
        const name = item.name.trim();
        const lessonName = cellText(item, col.name);
        if (!name) {
          report.skippedItems.push({ name: `(unnamed item ${item.id})`, reason: "no lesson id (item name)" });
          continue;
        }
        if (!lessonName) {
          report.skippedItems.push({ name, reason: "no Lesson Name" });
          continue;
        }
        const tags = cellText(item, col.tags)
          ?.split(",")
          .map((t) => t.trim())
          .filter(Boolean);
        sectionLessons.push({
          id: lessonIdFor(name),
          lessonName,
          ...(cellText(item, col.description) ? { description: cellText(item, col.description)! } : {}),
          ...(tags?.length ? { tags } : {}),
        });
      }
      // Display order = lesson numbering (25SWSimPro03_02 before 25SWSimPro03_10), not Monday's item order.
      sectionLessons.sort((a, b) => a.id.localeCompare(b.id, "en", { numeric: true, sensitivity: "base" }));
      return { sectionIndex: g.index, title: g.title, lessons: sectionLessons };
    });

  report.sections = sections.length;
  report.lessons = sections.reduce((n, s) => n + s.lessons.length, 0);
  return { input: { id: course.id, courseName: course.courseName, sections }, report };
}
