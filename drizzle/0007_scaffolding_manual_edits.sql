ALTER TABLE "course_translations" ADD COLUMN "edited_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "lesson_translations" ADD COLUMN "edited_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "section_translations" ADD COLUMN "edited_at" timestamp with time zone;