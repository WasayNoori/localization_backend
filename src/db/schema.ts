import { pgTable, text, timestamp } from "drizzle-orm/pg-core";

// id is a plain string, not a surrogate uuid: this will be populated
// directly from an LCMS-issued course ID once LCMS ships, with zero
// downstream migration required.
export const courses = pgTable("courses", {
  id: text("id").primaryKey(),
  courseName: text("course_name").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

// id is the same lesson_id string already referenced (as a bare string,
// no FK) by lesson_segments.lesson_id and lesson_localizations.lesson_id.
export const lessons = pgTable("lessons", {
  id: text("id").primaryKey(),
  courseId: text("course_id").notNull().references(() => courses.id),
  lessonName: text("lesson_name").notNull(),
  boxFileId: text("box_file_id").notNull(),
  // Set once this lesson's script has been split into segments.
  // Lesson-level fact, independent of any target language.
  parsedAt: timestamp("parsed_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});
