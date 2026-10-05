CREATE TABLE IF NOT EXISTS "course_translations" (
	"course_id" text NOT NULL,
	"target_language" varchar(10) NOT NULL,
	"course_name" text NOT NULL,
	"source_course_name" text NOT NULL,
	"deepl_glossary_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "course_translations_course_id_target_language_pk" PRIMARY KEY("course_id","target_language")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "lesson_translations" (
	"lesson_id" text NOT NULL,
	"target_language" varchar(10) NOT NULL,
	"lesson_name" text NOT NULL,
	"description" text,
	"source_lesson_name" text NOT NULL,
	"source_description" text,
	"deepl_glossary_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "lesson_translations_lesson_id_target_language_pk" PRIMARY KEY("lesson_id","target_language")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "section_translations" (
	"section_id" uuid NOT NULL,
	"target_language" varchar(10) NOT NULL,
	"title" text NOT NULL,
	"source_title" text NOT NULL,
	"deepl_glossary_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "section_translations_section_id_target_language_pk" PRIMARY KEY("section_id","target_language")
);
--> statement-breakpoint
ALTER TABLE "lessons" ADD COLUMN "tags" text[] DEFAULT '{}'::text[] NOT NULL;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "course_translations" ADD CONSTRAINT "course_translations_course_id_courses_id_fk" FOREIGN KEY ("course_id") REFERENCES "public"."courses"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "lesson_translations" ADD CONSTRAINT "lesson_translations_lesson_id_lessons_id_fk" FOREIGN KEY ("lesson_id") REFERENCES "public"."lessons"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "section_translations" ADD CONSTRAINT "section_translations_section_id_course_sections_id_fk" FOREIGN KEY ("section_id") REFERENCES "public"."course_sections"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
