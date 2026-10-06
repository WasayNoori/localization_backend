ALTER TABLE "course_translations" ADD COLUMN "review_status" text;--> statement-breakpoint
ALTER TABLE "course_translations" ADD COLUMN "review_note" text;--> statement-breakpoint
ALTER TABLE "course_translations" ADD COLUMN "reviewed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "lesson_translations" ADD COLUMN "review_status" text;--> statement-breakpoint
ALTER TABLE "lesson_translations" ADD COLUMN "review_note" text;--> statement-breakpoint
ALTER TABLE "lesson_translations" ADD COLUMN "reviewed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "section_translations" ADD COLUMN "review_status" text;--> statement-breakpoint
ALTER TABLE "section_translations" ADD COLUMN "review_note" text;--> statement-breakpoint
ALTER TABLE "section_translations" ADD COLUMN "reviewed_at" timestamp with time zone;