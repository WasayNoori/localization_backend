CREATE TABLE IF NOT EXISTS "language_translation_settings" (
	"target_language" varchar(10) PRIMARY KEY NOT NULL,
	"formality" text NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "segment_translations" ADD COLUMN "formality" text;