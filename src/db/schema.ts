import {
  pgTable,
  text,
  varchar,
  integer,
  numeric,
  boolean,
  timestamp,
  primaryKey,
  uuid,
  jsonb,
  uniqueIndex,
  index,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";

// id is our own stable internal string id — never rekeyed. lcmsCourseId is
// a separate nullable mapping column, populated once LCMS ships; internal
// id and everything that references it (course_lessons) never changes.
export const courses = pgTable("courses", {
  id: text("id").primaryKey(),
  courseName: text("course_name").notNull(),
  lcmsCourseId: text("lcms_course_id").unique(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

// id is the same lesson_id string already referenced (as a bare string,
// no FK) by lesson_segments.lesson_id and lesson_localizations.lesson_id.
// A lesson is an independent block — no course_id here; membership is
// many-to-many via course_lessons below.
// lcmsLessonId: same mapping approach as courses.lcmsCourseId — id itself
// never changes when LCMS ships, this column just records the mapping.
export const lessons = pgTable("lessons", {
  id: text("id").primaryKey(),
  lessonName: text("lesson_name").notNull(),
  // Nullable: a lesson can exist before its English script is uploaded to Box.
  boxFileId: text("box_file_id"),
  lcmsLessonId: text("lcms_lesson_id").unique(),
  // Set (and overwritten) every time this lesson's script is parsed into
  // segments. Re-parsing always rewrites lesson_segments, which cascades
  // to delete existing segment_translations/tts_clips for this lesson.
  parsedAt: timestamp("parsed_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

// Many-to-many: a lesson can belong to more than one course.
export const courseLessons = pgTable(
  "course_lessons",
  {
    courseId: text("course_id").notNull().references(() => courses.id),
    lessonId: text("lesson_id").notNull().references(() => lessons.id),
  },
  (table) => ({
    pk: primaryKey({ columns: [table.courseId, table.lessonId] }),
  }),
);

export interface ProcessingJobProgress {
  succeeded: string[];
  failed: { lessonId: string; error: string }[];
  total: number;
}

// Tracks course-level async fan-out only. Lesson-level parse/generate stay
// synchronous and never create a row here — only course-level scope has
// real duration + DeepL/ElevenLabs rate-limit concerns worth job-tracking.
export const processingJobs = pgTable("processing_jobs", {
  id: uuid("id").primaryKey().defaultRandom(),
  // 'course' only for now; stored as text (not a hardcoded enum) in case
  // lesson-level scope is ever job-tracked too.
  scope: text("scope").notNull(),
  targetId: text("target_id").notNull(),
  type: text("type").notNull(),
  // Set when type = 'generate'; null for 'parse'.
  targetLanguage: text("target_language"),
  status: text("status").notNull(),
  progress: jsonb("progress").$type<ProcessingJobProgress>().notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

// The English spaCy output. One row per ~300-400 character segment per
// lesson, shared across every target language. No course_id here and no FK
// to lessons — see docs/decisions.md ("lesson_segments.course_id dropped")
// for why: a lesson can belong to multiple courses via course_lessons, so a
// single denormalized course_id on a lesson-scoped row has no correct value.
export const lessonSegments = pgTable(
  "lesson_segments",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    lessonId: text("lesson_id").notNull(),
    sequenceIndex: integer("sequence_index").notNull(),
    text: text("text").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    lessonSequenceIdx: uniqueIndex("lesson_segments_lesson_sequence_idx").on(
      table.lessonId,
      table.sequenceIndex
    ),
  })
);

// DeepL's output for one segment in one target language. Independent of
// whether audio has been generated from it yet.
export const segmentTranslations = pgTable(
  "segment_translations",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    segmentId: uuid("segment_id")
      .notNull()
      .references(() => lessonSegments.id, { onDelete: "cascade" }),
    targetLanguage: varchar("target_language", { length: 10 }).notNull(),
    translatedText: text("translated_text").notNull(),
    // Snapshot of the glossary/context in effect at translation time, even
    // though glossaries is a global lookup — a later glossary update must
    // not retroactively change what this row says was used.
    deeplGlossaryId: text("deepl_glossary_id"),
    contextUsed: text("context_used"),
    billedCharacters: integer("billed_characters"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    segmentLanguageIdx: uniqueIndex("segment_translations_segment_language_idx").on(
      table.segmentId,
      table.targetLanguage
    ),
  })
);

export interface VoiceSettingsSnapshot {
  stability: number;
  similarityBoost: number;
  style?: number;
  speed?: number;
  useSpeakerBoost?: boolean;
}

// Tracks the translation/audio effort for one lesson into one target
// language (status, seed, default voice settings). Not used for English —
// English clips reference lesson_segments directly, no localization row.
// No course_id here — same reasoning as lesson_segments above.
export const lessonLocalizations = pgTable(
  "lesson_localizations",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    lessonId: text("lesson_id").notNull(),
    targetLanguage: varchar("target_language", { length: 10 }).notNull(),
    voiceId: text("voice_id").notNull(),
    modelId: text("model_id").notNull(),
    // Best-effort reproducibility only — ElevenLabs seed reuse isn't guaranteed.
    ttsSeed: integer("tts_seed").notNull(),
    defaultVoiceSettings: jsonb("default_voice_settings").$type<VoiceSettingsSnapshot>().notNull(),
    boxFolderId: text("box_folder_id"),
    // 'draft' | 'in_progress' | 'qc_review' | 'complete'
    status: text("status").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    lessonLanguageIdx: uniqueIndex("lesson_localizations_lesson_language_idx").on(
      table.lessonId,
      table.targetLanguage
    ),
  })
);

// A named, reusable bundle of ElevenLabs settings, selectable by id instead
// of specifying raw values every call.
export const voiceSettingTemplates = pgTable("voice_setting_templates", {
  id: uuid("id").primaryKey().defaultRandom(),
  name: text("name").notNull(),
  voiceId: text("voice_id").notNull(),
  modelId: text("model_id").notNull(),
  stability: numeric("stability").notNull(),
  similarityBoost: numeric("similarity_boost").notNull(),
  style: numeric("style"),
  speed: numeric("speed"),
  useSpeakerBoost: boolean("use_speaker_boost"),
  isActive: boolean("is_active").notNull().default(true),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

// DeepL manages glossary contents itself — we only store the glossary id
// per language. One row per target language, looked up by target_language,
// not FK-joined from segment_translations/lesson_localizations.
export const glossaries = pgTable("glossaries", {
  targetLanguage: varchar("target_language", { length: 10 }).primaryKey(),
  deeplGlossaryId: text("deepl_glossary_id").notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

// One row per generated audio segment, in either English or a target
// language. Soft regeneration: a failed/superseded attempt isn't
// overwritten, a new row is inserted with an incremented generationAttempt.
export const ttsClips = pgTable(
  "tts_clips",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    segmentId: uuid("segment_id")
      .notNull()
      .references(() => lessonSegments.id, { onDelete: "cascade" }),
    language: varchar("language", { length: 10 }).notNull(),
    // Null for English clips — English audio isn't a "localization".
    lessonLocalizationId: uuid("lesson_localization_id").references(() => lessonLocalizations.id),
    templateId: uuid("template_id").references(() => voiceSettingTemplates.id),
    // Snapshot of the exact text sent to ElevenLabs — the source segment or
    // its translation could be edited later; this preserves what was
    // actually spoken in this clip.
    sentenceText: text("sentence_text").notNull(),
    requestId: text("request_id"),
    seed: integer("seed").notNull(),
    voiceId: text("voice_id").notNull(),
    modelId: text("model_id").notNull(),
    voiceSettings: jsonb("voice_settings").$type<VoiceSettingsSnapshot>().notNull(),
    audioFormat: text("audio_format").notNull(),
    boxFileId: text("box_file_id"),
    boxFilePath: text("box_file_path"),
    // 'pending' | 'pass' | 'warn' | 'fail' | 'manual_review' | 'superseded'
    qcStatus: text("qc_status").notNull(),
    qcReport: jsonb("qc_report").$type<{ passed: boolean; issues: string[] }>(),
    generationAttempt: integer("generation_attempt").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    // Enforces at most one active (non-superseded) clip per segment+language
    // at a time — the invariant the generate-stage resume logic relies on.
    activeClipIdx: uniqueIndex("tts_clips_segment_language_active_idx")
      .on(table.segmentId, table.language)
      .where(sql`${table.qcStatus} <> 'superseded'`),
    lessonLocalizationIdx: index("tts_clips_lesson_localization_id_idx").on(
      table.lessonLocalizationId
    ),
    qcStatusIdx: index("tts_clips_qc_status_idx").on(table.qcStatus),
  })
);
