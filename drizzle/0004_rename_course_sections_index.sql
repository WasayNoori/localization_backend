-- Azure was first migrated with this index named course_sections_course_section_idx;
-- schema.ts names it course_sections_course_index_idx. No-op where it already matches.
ALTER INDEX IF EXISTS "course_sections_course_section_idx" RENAME TO "course_sections_course_index_idx";
