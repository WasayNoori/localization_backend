// src/services/catalog/importCourseStructure.ts
import { and, eq, inArray, notInArray } from "drizzle-orm";
import type { Database } from "../../db/client.js";
import { courses, courseSections, courseLessons, lessons } from "../../db/schema.js";

export interface ImportLessonInput {
  id: string;
  lessonName: string;
  description?: string;
  /** Full English script. Omit to leave an existing script untouched. */
  scriptText?: string;
}

export interface ImportSectionInput {
  /** 1-based display order within the course. */
  sectionIndex: number;
  title: string;
  /** In display order — array position becomes course_lessons.position. */
  lessons: ImportLessonInput[];
}

export interface ImportCourseInput {
  id: string;
  courseName: string;
  /** 'Released' | 'Draft'. Omit to leave the stored status unchanged. */
  status?: "Released" | "Draft";
  sections: ImportSectionInput[];
}

export interface ImportCourseResult {
  courseId: string;
  sectionCount: number;
  lessonCount: number;
  lessonsCreated: string[];
  lessonsUpdated: string[];
  /** Lessons whose script_text was set or changed by this import. */
  scriptsChanged: string[];
  /** Subset of scriptsChanged that were already parsed — their segments are now stale. */
  needsReparse: string[];
}

export class CourseImportValidationError extends Error {}

/**
 * Idempotent upsert of a course's full structure: course → ordered sections →
 * ordered lessons (+ optional script text), in one transaction. The payload
 * is the complete desired structure: membership and sections missing from it
 * are removed from this course. Lessons themselves are never deleted (they
 * may belong to other courses and own segments/translations/audio).
 *
 * Never parses. A changed script only bumps script_updated_at; the caller
 * decides when to re-parse, since re-parse destroys translations and audio.
 */
export async function importCourseStructure(db: Database, input: ImportCourseInput): Promise<ImportCourseResult> {
  validate(input);

  const allLessons = input.sections.flatMap((s) => s.lessons);
  const lessonIds = allLessons.map((l) => l.id);
  const now = new Date();

  return db.transaction(async (tx) => {
    await tx
      .insert(courses)
      .values({ id: input.id, courseName: input.courseName, status: input.status ?? null })
      .onConflictDoUpdate({
        target: courses.id,
        set: {
          courseName: input.courseName,
          ...(input.status !== undefined ? { status: input.status } : {}),
          updatedAt: now,
        },
      });

    const sectionIdByIndex = new Map<number, string>();
    for (const section of input.sections) {
      const [row] = await tx
        .insert(courseSections)
        .values({ courseId: input.id, sectionIndex: section.sectionIndex, title: section.title })
        .onConflictDoUpdate({
          target: [courseSections.courseId, courseSections.sectionIndex],
          set: { title: section.title, updatedAt: now },
        })
        .returning({ id: courseSections.id });
      sectionIdByIndex.set(section.sectionIndex, row.id);
    }

    const existingRows = lessonIds.length
      ? await tx.select().from(lessons).where(inArray(lessons.id, lessonIds))
      : [];
    const existingById = new Map(existingRows.map((r) => [r.id, r]));

    const result: ImportCourseResult = {
      courseId: input.id,
      sectionCount: input.sections.length,
      lessonCount: allLessons.length,
      lessonsCreated: [],
      lessonsUpdated: [],
      scriptsChanged: [],
      needsReparse: [],
    };

    for (const lesson of allLessons) {
      const existing = existingById.get(lesson.id);
      const scriptChanged = lesson.scriptText !== undefined && lesson.scriptText !== existing?.scriptText;

      if (!existing) {
        await tx.insert(lessons).values({
          id: lesson.id,
          lessonName: lesson.lessonName,
          description: lesson.description ?? null,
          scriptText: lesson.scriptText ?? null,
          scriptUpdatedAt: lesson.scriptText !== undefined ? now : null,
        });
        result.lessonsCreated.push(lesson.id);
      } else {
        await tx
          .update(lessons)
          .set({
            lessonName: lesson.lessonName,
            description: lesson.description ?? existing.description,
            ...(scriptChanged ? { scriptText: lesson.scriptText, scriptUpdatedAt: now } : {}),
            updatedAt: now,
          })
          .where(eq(lessons.id, lesson.id));
        result.lessonsUpdated.push(lesson.id);
        if (scriptChanged && existing.parsedAt) {
          result.needsReparse.push(lesson.id);
        }
      }

      if (scriptChanged) {
        result.scriptsChanged.push(lesson.id);
      }
    }

    // Membership is replaced wholesale — the payload is the full structure.
    await tx.delete(courseLessons).where(eq(courseLessons.courseId, input.id));
    const membershipRows = input.sections.flatMap((section) =>
      section.lessons.map((lesson, i) => ({
        courseId: input.id,
        lessonId: lesson.id,
        sectionId: sectionIdByIndex.get(section.sectionIndex)!,
        position: i + 1,
      }))
    );
    if (membershipRows.length) {
      await tx.insert(courseLessons).values(membershipRows);
    }

    // Drop sections no longer in the payload (safe: membership already replaced).
    const keptIndexes = input.sections.map((s) => s.sectionIndex);
    await tx
      .delete(courseSections)
      .where(
        keptIndexes.length
          ? and(eq(courseSections.courseId, input.id), notInArray(courseSections.sectionIndex, keptIndexes))
          : eq(courseSections.courseId, input.id)
      );

    return result;
  });
}

function validate(input: ImportCourseInput): void {
  const seenSections = new Set<number>();
  const seenLessons = new Set<string>();
  for (const section of input.sections) {
    if (seenSections.has(section.sectionIndex)) {
      throw new CourseImportValidationError(`Duplicate sectionIndex ${section.sectionIndex}`);
    }
    seenSections.add(section.sectionIndex);
    for (const lesson of section.lessons) {
      if (seenLessons.has(lesson.id)) {
        throw new CourseImportValidationError(`Lesson "${lesson.id}" appears more than once in the course`);
      }
      seenLessons.add(lesson.id);
    }
  }
}
