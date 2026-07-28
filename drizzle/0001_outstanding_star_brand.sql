CREATE TABLE IF NOT EXISTS "language_voice_settings" (
	"target_language" varchar(10) PRIMARY KEY NOT NULL,
	"voice_id" text NOT NULL,
	"model_id" text NOT NULL,
	"voice_settings" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "lesson_localizations" DROP COLUMN IF EXISTS "voice_id";--> statement-breakpoint
ALTER TABLE "lesson_localizations" DROP COLUMN IF EXISTS "model_id";--> statement-breakpoint
ALTER TABLE "lesson_localizations" DROP COLUMN IF EXISTS "default_voice_settings";