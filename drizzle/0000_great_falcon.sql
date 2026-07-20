CREATE TABLE IF NOT EXISTS "course_lessons" (
	"course_id" text NOT NULL,
	"lesson_id" text NOT NULL,
	CONSTRAINT "course_lessons_course_id_lesson_id_pk" PRIMARY KEY("course_id","lesson_id")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "courses" (
	"id" text PRIMARY KEY NOT NULL,
	"course_name" text NOT NULL,
	"lcms_course_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "courses_lcms_course_id_unique" UNIQUE("lcms_course_id")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "glossaries" (
	"target_language" varchar(10) PRIMARY KEY NOT NULL,
	"deepl_glossary_id" text NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "lesson_localizations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"lesson_id" text NOT NULL,
	"target_language" varchar(10) NOT NULL,
	"voice_id" text NOT NULL,
	"model_id" text NOT NULL,
	"tts_seed" integer NOT NULL,
	"default_voice_settings" jsonb NOT NULL,
	"box_folder_id" text,
	"status" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "lesson_segments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"lesson_id" text NOT NULL,
	"sequence_index" integer NOT NULL,
	"text" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "lessons" (
	"id" text PRIMARY KEY NOT NULL,
	"lesson_name" text NOT NULL,
	"box_file_id" text,
	"lcms_lesson_id" text,
	"parsed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "lessons_lcms_lesson_id_unique" UNIQUE("lcms_lesson_id")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "processing_jobs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"scope" text NOT NULL,
	"target_id" text NOT NULL,
	"type" text NOT NULL,
	"target_language" text,
	"status" text NOT NULL,
	"progress" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "segment_translations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"segment_id" uuid NOT NULL,
	"target_language" varchar(10) NOT NULL,
	"translated_text" text NOT NULL,
	"deepl_glossary_id" text,
	"context_used" text,
	"billed_characters" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "tts_clips" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"segment_id" uuid NOT NULL,
	"language" varchar(10) NOT NULL,
	"lesson_localization_id" uuid,
	"template_id" uuid,
	"sentence_text" text NOT NULL,
	"request_id" text,
	"seed" integer NOT NULL,
	"voice_id" text NOT NULL,
	"model_id" text NOT NULL,
	"voice_settings" jsonb NOT NULL,
	"audio_format" text NOT NULL,
	"box_file_id" text,
	"box_file_path" text,
	"qc_status" text NOT NULL,
	"qc_report" jsonb,
	"generation_attempt" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "voice_setting_templates" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"voice_id" text NOT NULL,
	"model_id" text NOT NULL,
	"stability" numeric NOT NULL,
	"similarity_boost" numeric NOT NULL,
	"style" numeric,
	"speed" numeric,
	"use_speaker_boost" boolean,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "course_lessons" ADD CONSTRAINT "course_lessons_course_id_courses_id_fk" FOREIGN KEY ("course_id") REFERENCES "public"."courses"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "course_lessons" ADD CONSTRAINT "course_lessons_lesson_id_lessons_id_fk" FOREIGN KEY ("lesson_id") REFERENCES "public"."lessons"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "segment_translations" ADD CONSTRAINT "segment_translations_segment_id_lesson_segments_id_fk" FOREIGN KEY ("segment_id") REFERENCES "public"."lesson_segments"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "tts_clips" ADD CONSTRAINT "tts_clips_segment_id_lesson_segments_id_fk" FOREIGN KEY ("segment_id") REFERENCES "public"."lesson_segments"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "tts_clips" ADD CONSTRAINT "tts_clips_lesson_localization_id_lesson_localizations_id_fk" FOREIGN KEY ("lesson_localization_id") REFERENCES "public"."lesson_localizations"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "tts_clips" ADD CONSTRAINT "tts_clips_template_id_voice_setting_templates_id_fk" FOREIGN KEY ("template_id") REFERENCES "public"."voice_setting_templates"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "lesson_localizations_lesson_language_idx" ON "lesson_localizations" USING btree ("lesson_id","target_language");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "lesson_segments_lesson_sequence_idx" ON "lesson_segments" USING btree ("lesson_id","sequence_index");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "segment_translations_segment_language_idx" ON "segment_translations" USING btree ("segment_id","target_language");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "tts_clips_segment_language_active_idx" ON "tts_clips" USING btree ("segment_id","language") WHERE "tts_clips"."qc_status" <> 'superseded';--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "tts_clips_lesson_localization_id_idx" ON "tts_clips" USING btree ("lesson_localization_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "tts_clips_qc_status_idx" ON "tts_clips" USING btree ("qc_status");