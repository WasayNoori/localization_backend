CREATE TABLE IF NOT EXISTS "ambiguous_term_senses" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"term_id" uuid NOT NULL,
	"meaning" text NOT NULL,
	"translations" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"position" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "ambiguous_terms" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"term" text NOT NULL,
	"note" text,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "segment_term_senses" (
	"segment_id" uuid NOT NULL,
	"term_id" uuid NOT NULL,
	"sense_id" uuid,
	"outcome" text NOT NULL,
	"decided_by" text NOT NULL,
	"note" text,
	"decided_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "segment_term_senses_segment_id_term_id_pk" PRIMARY KEY("segment_id","term_id")
);
--> statement-breakpoint
ALTER TABLE "segment_translations" ADD COLUMN "term_guidance" jsonb;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "ambiguous_term_senses" ADD CONSTRAINT "ambiguous_term_senses_term_id_ambiguous_terms_id_fk" FOREIGN KEY ("term_id") REFERENCES "public"."ambiguous_terms"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "segment_term_senses" ADD CONSTRAINT "segment_term_senses_segment_id_lesson_segments_id_fk" FOREIGN KEY ("segment_id") REFERENCES "public"."lesson_segments"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "segment_term_senses" ADD CONSTRAINT "segment_term_senses_term_id_ambiguous_terms_id_fk" FOREIGN KEY ("term_id") REFERENCES "public"."ambiguous_terms"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "segment_term_senses" ADD CONSTRAINT "segment_term_senses_sense_id_ambiguous_term_senses_id_fk" FOREIGN KEY ("sense_id") REFERENCES "public"."ambiguous_term_senses"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "ambiguous_term_senses_term_id_idx" ON "ambiguous_term_senses" USING btree ("term_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "ambiguous_terms_term_idx" ON "ambiguous_terms" USING btree (lower("term"));--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "segment_term_senses_term_id_idx" ON "segment_term_senses" USING btree ("term_id");