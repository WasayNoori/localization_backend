// src/services/catalog/saveCourseDetails.ts
import { eq } from "drizzle-orm";
import type { Database } from "../../db/client.js";
import { courses } from "../../db/schema.js";

export type CourseStatus = "Released" | "Draft";

/** Course-level details only — sections and lessons come in through the import. */
export interface CourseDetailsInput {
  courseName?: string;
  /** "" clears it. */
  description?: string;
  status?: CourseStatus;
  /** Numeric Box folder id; "" clears it. */
  boxFolderId?: string;
  /** Numeric monday.com board id; "" clears it. */
  mondayBoardId?: string;
}

export interface NewCourseInput extends CourseDetailsInput {
  /** Course id, also the lesson-id prefix (e.g. "25Sim" → lessons 25Sim01_01…). Fixed once created. */
  id: string;
  courseName: string;
}

export class CourseDetailsError extends Error {
  constructor(
    public readonly statusCode: 400 | 404 | 409,
    message: string
  ) {
    super(message);
  }
}

/** Letters, digits, "-" and "_" — the id becomes a prefix of lesson ids and Box/file names. */
const COURSE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;

export async function createCourse(db: Database, input: NewCourseInput) {
  const id = input.id.trim();
  if (!COURSE_ID_PATTERN.test(id)) {
    throw new CourseDetailsError(400, `Course id "${input.id}" may only use letters, digits, "-" and "_"`);
  }
  const values = normalize(input);
  if (!values.courseName) throw new CourseDetailsError(400, "courseName is required");

  const [existing] = await db.select({ id: courses.id }).from(courses).where(eq(courses.id, id)).limit(1);
  if (existing) throw new CourseDetailsError(409, `A course with id "${id}" already exists`);

  const [created] = await db
    .insert(courses)
    .values({
      id,
      courseName: values.courseName,
      description: values.description ?? null,
      status: values.status ?? null,
      boxFolderId: values.boxFolderId ?? null,
      mondayBoardId: values.mondayBoardId ?? null,
    })
    .returning();
  return created;
}

/** Partial update: omitted fields keep their stored value. The id never changes. */
export async function updateCourseDetails(db: Database, courseId: string, input: CourseDetailsInput) {
  const values = normalize(input);
  if (values.courseName === "") throw new CourseDetailsError(400, "courseName can't be empty");
  if (!Object.keys(values).length) throw new CourseDetailsError(400, "Nothing to update");

  const [updated] = await db
    .update(courses)
    .set({ ...values, updatedAt: new Date() })
    .where(eq(courses.id, courseId))
    .returning();
  if (!updated) throw new CourseDetailsError(404, `No course with id "${courseId}"`);
  return updated;
}

/** Trims text, turns "" into null for optional fields, validates the Box folder and Monday board ids. */
function normalize(input: CourseDetailsInput) {
  const out: {
    courseName?: string;
    description?: string | null;
    status?: CourseStatus;
    boxFolderId?: string | null;
    mondayBoardId?: string | null;
  } = {};
  if (input.courseName !== undefined) out.courseName = input.courseName.trim();
  if (input.description !== undefined) out.description = input.description.trim() || null;
  if (input.status !== undefined) out.status = input.status;
  if (input.boxFolderId !== undefined) {
    const folder = input.boxFolderId.trim();
    if (folder && !/^\d+$/.test(folder)) throw new CourseDetailsError(400, `Box folder id must be numeric: "${input.boxFolderId}"`);
    out.boxFolderId = folder || null;
  }
  if (input.mondayBoardId !== undefined) {
    const board = input.mondayBoardId.trim();
    if (board && !/^\d+$/.test(board)) throw new CourseDetailsError(400, `Monday board id must be numeric: "${input.mondayBoardId}"`);
    out.mondayBoardId = board || null;
  }
  return out;
}
