ALTER TABLE "course_translations" ADD COLUMN "description" text;--> statement-breakpoint
ALTER TABLE "course_translations" ADD COLUMN "source_description" text;--> statement-breakpoint
ALTER TABLE "courses" ADD COLUMN "description" text;