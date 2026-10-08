// src/services/audit/auditCourseAudio.ts
import { and, asc, eq, inArray, ne } from "drizzle-orm";
import type { Database } from "../../db/client.js";
import { courses, lessonSegments, ttsClips } from "../../db/schema.js";
import type { IFileStorageService, StoredItem } from "../../interfaces/IFileStorageService.js";
import { courseLessonOrder } from "../translation/translateCourseLessons.js";
import { clipFileName, clipsDirInCourse, languageFolder, lessonDirInCourse, segmentsFileName } from "../output/outputLayout.js";

export interface AuditCourseAudioDeps {
  db: Database;
  fileStorageService: IFileStorageService;
}

export interface CourseAudioAudit {
  courseId: string;
  language: string;
  checkedAt: string;
  /** True when every lesson has a Box clip per segment, its Segments.txt, and nothing is out of place. */
  ok: boolean;
  lessons: number;
  lessonsOk: number;
  totals: { segments: number; clipsInDb: number; clipsInBox: number };
  /** Things that are wrong — a lesson isn't complete in Box. */
  problems: { lessonId?: string; problem: string }[];
  /** Worth a look, but not wrong in themselves (e.g. a gap in lesson numbering, an extra file). */
  warnings: { lessonId?: string; warning: string }[];
}

export class AuditError extends Error {
  constructor(public readonly statusCode: 400 | 404, message: string) {
    super(message);
  }
}

/**
 * Checks that a course's audio for one language is complete and in place:
 * for every lesson, the database has one Box-linked clip per segment, and
 * Box has the lesson folder, its Segments.txt and exactly the clips
 * 001…N — each the file the database points to. Also warns about gaps in
 * lesson numbering (25Sim03_01, 25Sim03_03 — no 03_02) and lesson folders in
 * Box that aren't in the course. Reads Box fresh; changes nothing.
 */
export async function auditCourseAudio(deps: AuditCourseAudioDeps, courseId: string, language: string): Promise<CourseAudioAudit> {
  const { db, fileStorageService: box } = deps;
  const [course] = await db.select().from(courses).where(eq(courses.id, courseId)).limit(1);
  if (!course) throw new AuditError(404, `No course with id "${courseId}"`);
  if (!course.boxFolderId) throw new AuditError(400, `Course "${courseId}" has no Box folder`);

  const audit: CourseAudioAudit = {
    courseId,
    language,
    checkedAt: new Date().toISOString(),
    ok: false,
    lessons: 0,
    lessonsOk: 0,
    totals: { segments: 0, clipsInDb: 0, clipsInBox: 0 },
    problems: [],
    warnings: [],
  };
  const lessonIds = await courseLessonOrder(db, courseId);
  audit.lessons = lessonIds.length;
  audit.warnings.push(...numberingGaps(lessonIds).map((warning) => ({ warning })));

  const languageFolderId = await box.findFolderPath(course.boxFolderId, [languageFolder(language)]);
  if (!languageFolderId) {
    audit.problems.push({ problem: `No ${languageFolder(language)} folder in the course's Box folder` });
    return audit;
  }
  const inCourse = new Set(lessonIds);
  for (const item of await box.listItems(languageFolderId)) {
    if (item.type === "folder" && !inCourse.has(item.name)) {
      audit.warnings.push({ lessonId: item.name, warning: `Folder ${languageFolder(language)}/${item.name} in Box isn't a lesson of this course` });
    }
  }

  for (const lessonId of lessonIds) {
    const problems = await auditLesson(deps, course.boxFolderId, lessonId, language, audit);
    audit.problems.push(...problems.map((problem) => ({ lessonId, problem })));
    if (!problems.length) audit.lessonsOk++;
  }
  audit.ok = audit.problems.length === 0;
  return audit;
}

async function auditLesson(
  deps: AuditCourseAudioDeps,
  courseFolderId: string,
  lessonId: string,
  language: string,
  audit: CourseAudioAudit
): Promise<string[]> {
  const { db, fileStorageService: box } = deps;
  const problems: string[] = [];
  const target = { lessonId, language };

  const segments = await db
    .select({ id: lessonSegments.id })
    .from(lessonSegments)
    .where(eq(lessonSegments.lessonId, lessonId))
    .orderBy(asc(lessonSegments.sequenceIndex));
  if (!segments.length) return ["Not parsed — no segments"];
  audit.totals.segments += segments.length;

  // Database: one active (not superseded) clip per segment, with a Box file id.
  const clips = await db
    .select({ segmentId: ttsClips.segmentId, boxFileId: ttsClips.boxFileId, qcStatus: ttsClips.qcStatus })
    .from(ttsClips)
    .where(and(eq(ttsClips.language, language), ne(ttsClips.qcStatus, "superseded"), inArray(ttsClips.segmentId, segments.map((s) => s.id))));
  const clipBySegment = new Map<string, (typeof clips)[number]>();
  for (const c of clips) {
    if (clipBySegment.has(c.segmentId)) problems.push(`Segment ${segmentNumberOf(segments, c.segmentId)} has more than one active clip`);
    clipBySegment.set(c.segmentId, c);
  }
  const expectedIds = new Map<string, string>(); // clip file name → Box file id the database expects
  const noClip: number[] = [];
  const noBoxId: number[] = [];
  const qcFailed: number[] = [];
  segments.forEach((s, i) => {
    const clip = clipBySegment.get(s.id);
    if (!clip) return void noClip.push(i + 1);
    if (clip.qcStatus === "fail") qcFailed.push(i + 1);
    if (!clip.boxFileId) return void noBoxId.push(i + 1);
    audit.totals.clipsInDb++;
    expectedIds.set(clipFileName(target, i + 1), clip.boxFileId);
  });
  if (noClip.length) problems.push(`No clip for segment(s) ${ranges(noClip)} of ${segments.length}`);
  if (noBoxId.length) problems.push(`Clip(s) ${ranges(noBoxId)} not in Box (no Box file id)`);
  if (qcFailed.length) problems.push(`Clip(s) ${ranges(qcFailed)} failed QC`);

  // Box: lesson folder, Segments.txt, and exactly clips 001…N, each the file the database points to.
  const lessonFolderId = await box.findFolderPath(courseFolderId, lessonDirInCourse(target));
  if (!lessonFolderId) return [...problems, `No lesson folder ${lessonDirInCourse(target).join("/")} in Box`];
  const lessonItems = byName(await box.listItems(lessonFolderId));
  if (lessonItems.get(segmentsFileName(target))?.type !== "file") problems.push(`${segmentsFileName(target)} missing in Box`);

  const clipsFolderName = clipsDirInCourse(target).at(-1)!;
  const clipsFolder = lessonItems.get(clipsFolderName);
  if (clipsFolder?.type !== "folder") return [...problems, `No "${clipsFolderName}" folder in Box`];
  const files = byName((await box.listItems(clipsFolder.id)).filter((i) => i.type === "file"));

  const missingInBox: number[] = [];
  const wrongFile: number[] = [];
  for (let n = 1; n <= segments.length; n++) {
    const name = clipFileName(target, n);
    const file = files.get(name);
    if (!file) {
      missingInBox.push(n);
      continue;
    }
    audit.totals.clipsInBox++;
    const expected = expectedIds.get(name);
    if (expected && expected !== file.id) wrongFile.push(n);
  }
  if (missingInBox.length) problems.push(`Clip file(s) ${ranges(missingInBox)} missing in Box`);
  if (wrongFile.length) problems.push(`Clip(s) ${ranges(wrongFile)}: the Box file isn't the one the database points to`);

  const expectedNames = new Set(Array.from({ length: segments.length }, (_, i) => clipFileName(target, i + 1)));
  const extra = [...files.keys()].filter((name) => !expectedNames.has(name)).sort();
  if (extra.length) {
    audit.warnings.push({ lessonId, warning: `Extra file(s) in "${clipsFolderName}": ${extra.join(", ")} (left from an earlier, longer version?)` });
  }
  return problems;
}

const byName = (items: StoredItem[]) => new Map(items.map((i) => [i.name, i]));

const segmentNumberOf = (segments: { id: string }[], segmentId: string) => segments.findIndex((s) => s.id === segmentId) + 1;

/** [1,2,3,5,7,8] → "001–003, 005, 007–008" */
function ranges(numbers: number[]): string {
  const pad = (n: number) => String(n).padStart(3, "0");
  const out: string[] = [];
  for (let i = 0; i < numbers.length; i++) {
    let j = i;
    while (j + 1 < numbers.length && numbers[j + 1] === numbers[j] + 1) j++;
    out.push(i === j ? pad(numbers[i]) : `${pad(numbers[i])}–${pad(numbers[j])}`);
    i = j;
  }
  return out.join(", ");
}

/**
 * Gaps in lesson numbering, from ids ending in <section>_<lesson>
 * (25Sim03_01): a section missing from the sequence, or a lesson number
 * skipped within a section. Ids that don't follow the pattern are ignored.
 */
export function numberingGaps(lessonIds: string[]): string[] {
  const bySection = new Map<number, Set<number>>();
  let prefix = "";
  for (const id of lessonIds) {
    const m = /^(.*?)(\d+)_(\d+)$/.exec(id);
    if (!m) continue;
    prefix ||= m[1];
    const section = Number(m[2]);
    if (!bySection.has(section)) bySection.set(section, new Set());
    bySection.get(section)!.add(Number(m[3]));
  }
  const gaps: string[] = [];
  const two = (n: number) => String(n).padStart(2, "0");
  const sections = [...bySection.keys()].sort((a, b) => a - b);
  for (let s = 1; s <= (sections.at(-1) ?? 0); s++) {
    const lessons = bySection.get(s);
    if (!lessons) {
      gaps.push(`No lessons numbered ${prefix}${two(s)}_xx — section ${s} skipped?`);
      continue;
    }
    const max = Math.max(...lessons);
    const missing = Array.from({ length: max }, (_, i) => i + 1).filter((n) => !lessons.has(n));
    if (missing.length) gaps.push(`Lesson number(s) skipped in section ${s}: ${missing.map((n) => `${prefix}${two(s)}_${two(n)}`).join(", ")}`);
  }
  return gaps;
}
