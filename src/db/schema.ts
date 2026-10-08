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
  // Learner-facing course description; part of the scaffolding. Null = none.
  description: text("description"),
  // 'Released' | 'Draft'. Nullable: owned by the BI app / LCMS, set via
  // POST /courses/import until a catalog sync exists.
  status: text("status"),
  lcmsCourseId: text("lcms_course_id").unique(),
  // Top-level Box folder for this course's outputs. The pipeline creates
  // <Language>/<lessonId>/<Language> Clips/ under it. Null = not set (audio
  // can't go to Box for this course yet).
  boxFolderId: text("box_folder_id"),
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
  // Short learner-facing summary shown under the lesson title on the platform.
  description: text("description"),
  // Full English script. Source of truth for parsing while the Box folder
  // structure is undecided — see docs/decisions.md ("Script text lives in the DB").
  scriptText: text("script_text"),
  // The script exactly as loaded (file text) that script_text was proofread
  // from — set even when proofreading changed nothing. Reloading the same
  // source skips proofreading, so reloads stay idempotent (no re-parse from
  // slightly different fixes). Null = not proofread.
  scriptSourceText: text("script_source_text"),
  // Bumped only when script_text actually changes. script_updated_at >
  // parsed_at means existing segments were cut from an older script.
  scriptUpdatedAt: timestamp("script_updated_at", { withTimezone: true }),
  // Box file ID of the English source script. Nullable and optional: kept as
  // the future pointer once the Box structure is settled; parsing only falls
  // back to it when script_text is null.
  boxFileId: text("box_file_id"),
  // Search/catalog tags from the course board ("Lesson Level Tags"). Not
  // translated; stored as given.
  tags: text("tags").array().notNull().default(sql`'{}'::text[]`),
  lcmsLessonId: text("lcms_lesson_id").unique(),
  // Set (and overwritten) every time this lesson's script is parsed into
  // segments. Re-parsing always rewrites lesson_segments, which cascades
  // to delete existing segment_translations/tts_clips for this lesson.
  parsedAt: timestamp("parsed_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

// A course's ordered sections ("Section 1 - Introduction to Simulation").
// Sections belong to one course; lessons attach to a section through
// course_lessons, since a lesson can sit in different sections of
// different courses.
export const courseSections = pgTable(
  "course_sections",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    courseId: text("course_id").notNull().references(() => courses.id),
    // 1-based display order within the course.
    sectionIndex: integer("section_index").notNull(),
    title: text("title").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    courseSectionIdx: uniqueIndex("course_sections_course_index_idx").on(table.courseId, table.sectionIndex),
  })
);

// Many-to-many: a lesson can belong to more than one course. Placement
// (section + order) is per course membership, so it lives here, not on lessons.
export const courseLessons = pgTable(
  "course_lessons",
  {
    courseId: text("course_id").notNull().references(() => courses.id),
    lessonId: text("lesson_id").notNull().references(() => lessons.id),
    // Nullable so pre-existing membership rows stay valid; set by course import.
    sectionId: uuid("section_id").references(() => courseSections.id),
    // 1-based order of the lesson within its section.
    position: integer("position"),
  },
  (table) => ({
    pk: primaryKey({ columns: [table.courseId, table.lessonId] }),
  }),
);

// Translated catalog text — course name, section titles, lesson names and
// descriptions — one row per item per language. `source_*` snapshots the
// English that was translated: when it differs from the current English the
// translation is stale (same idea as tts_clips.sentence_text vs the current
// translation). Typed per entity (not one generic table) so each row has a
// real FK and goes away with its course/section/lesson.
export const courseTranslations = pgTable(
  "course_translations",
  {
    courseId: text("course_id")
      .notNull()
      .references(() => courses.id, { onDelete: "cascade" }),
    targetLanguage: varchar("target_language", { length: 10 }).notNull(),
    courseName: text("course_name").notNull(),
    // Null when the English course has no description.
    description: text("description"),
    sourceCourseName: text("source_course_name").notNull(),
    sourceDescription: text("source_description"),
    deeplGlossaryId: text("deepl_glossary_id"),
    // Claude sanity check of DeepL's output (flag-only, never a rewrite):
    // 'ok' | 'flagged'; null = not reviewed (reviewer failed or unavailable).
    reviewStatus: text("review_status"),
    reviewNote: text("review_note"),
    reviewedAt: timestamp("reviewed_at", { withTimezone: true }),
    // Set when a person corrected the text by hand (PUT .../scaffolding/
    // translations/:lang); review fields are then null. "Re-translate all"
    // keeps corrections; only a change to the English replaces them.
    editedAt: timestamp("edited_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    pk: primaryKey({ columns: [table.courseId, table.targetLanguage] }),
  })
);

export const sectionTranslations = pgTable(
  "section_translations",
  {
    sectionId: uuid("section_id")
      .notNull()
      .references(() => courseSections.id, { onDelete: "cascade" }),
    targetLanguage: varchar("target_language", { length: 10 }).notNull(),
    title: text("title").notNull(),
    sourceTitle: text("source_title").notNull(),
    deeplGlossaryId: text("deepl_glossary_id"),
    // Claude sanity check of DeepL's output (flag-only, never a rewrite):
    // 'ok' | 'flagged'; null = not reviewed (reviewer failed or unavailable).
    reviewStatus: text("review_status"),
    reviewNote: text("review_note"),
    reviewedAt: timestamp("reviewed_at", { withTimezone: true }),
    // Set when a person corrected the text by hand (PUT .../scaffolding/
    // translations/:lang); review fields are then null. "Re-translate all"
    // keeps corrections; only a change to the English replaces them.
    editedAt: timestamp("edited_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    pk: primaryKey({ columns: [table.sectionId, table.targetLanguage] }),
  })
);

export const lessonTranslations = pgTable(
  "lesson_translations",
  {
    lessonId: text("lesson_id")
      .notNull()
      .references(() => lessons.id, { onDelete: "cascade" }),
    targetLanguage: varchar("target_language", { length: 10 }).notNull(),
    lessonName: text("lesson_name").notNull(),
    // Null when the English lesson has no description.
    description: text("description"),
    sourceLessonName: text("source_lesson_name").notNull(),
    sourceDescription: text("source_description"),
    deeplGlossaryId: text("deepl_glossary_id"),
    // Claude sanity check of DeepL's output (flag-only, never a rewrite):
    // 'ok' | 'flagged'; null = not reviewed (reviewer failed or unavailable).
    reviewStatus: text("review_status"),
    reviewNote: text("review_note"),
    reviewedAt: timestamp("reviewed_at", { withTimezone: true }),
    // Set when a person corrected the text by hand (PUT .../scaffolding/
    // translations/:lang); review fields are then null. "Re-translate all"
    // keeps corrections; only a change to the English replaces them.
    editedAt: timestamp("edited_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    pk: primaryKey({ columns: [table.lessonId, table.targetLanguage] }),
  })
);

export interface ProcessingJobProgress {
  succeeded: string[];
  failed: { lessonId: string; error: string }[];
  total: number;
  /** Lessons the job left alone, with why (e.g. "not parsed", "already translated"). */
  skipped?: { lessonId: string; reason: string }[];
  /** Options the job ran with, e.g. { mode: "missing" }. */
  options?: Record<string, string>;
  /** Why the job as a whole failed (crash, server restart) — per-lesson errors are in `failed`. */
  error?: string;
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
  // Set when type = 'translate' | 'generate'; null for 'parse'.
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
    // Snapshot of the language's formality setting used (null = none set).
    // A row whose formality differs from the current setting is stale and
    // gets re-translated by the course translation's "missing" mode.
    formality: text("formality"),
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
// language (status, seed, Box destination folder). Voice configuration
// (voice_id/model_id/voice_settings) lives in language_voice_settings
// instead — that's a per-language, not per-lesson, concern: a voice is
// picked for a language and reused until retired, across every lesson in
// that language, not chosen per lesson. See docs/decisions.md. Created for
// English too now — English has no translation effort, but still has a
// generation effort (seed/folder/status) worth tracking the same way.
// No course_id here — same reasoning as lesson_segments above.
export const lessonLocalizations = pgTable(
  "lesson_localizations",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    lessonId: text("lesson_id").notNull(),
    targetLanguage: varchar("target_language", { length: 10 }).notNull(),
    // Best-effort reproducibility only — ElevenLabs seed reuse isn't guaranteed.
    ttsSeed: integer("tts_seed").notNull(),
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

// DeepL settings for one target language other than the glossary (which
// stays in glossaries). Formality fixes formal vs informal "you" across a
// language (Spanish usted vs tú) — without it DeepL decides per sentence.
// No row = DeepL's default.
export const languageTranslationSettings = pgTable("language_translation_settings", {
  targetLanguage: varchar("target_language", { length: 10 }).primaryKey(),
  // 'default' | 'more' | 'less' | 'prefer_more' | 'prefer_less' (ITranslationService.Formality)
  formality: text("formality").notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

// Voice configuration for one target language, shared by every lesson —
// not per-lesson. A voice is picked for a language and reused until it's
// retired, then swapped for another; that swap is a language-wide event,
// not scoped to any one lesson. Same shape/pattern as glossaries above — a
// future DeepL pronunciation dictionary id per language belongs here too,
// not on glossaries (a translation concern) or lesson_localizations (a
// per-lesson concern).
export const languageVoiceSettings = pgTable("language_voice_settings", {
  targetLanguage: varchar("target_language", { length: 10 }).primaryKey(),
  voiceId: text("voice_id").notNull(),
  modelId: text("model_id").notNull(),
  voiceSettings: jsonb("voice_settings").$type<VoiceSettingsSnapshot>().notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
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
    // Set for every clip, English included — lesson_localizations now tracks
    // per-lesson generation effort (seed/folder/status) for every language,
    // not just translated ones. Nullable only because this column predates
    // that; a clip without one shouldn't occur going forward.
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
    // POC: where the clip was saved on disk while Box isn't set up
    // (LocalFolderClipStore), relative to LOCAL_OUTPUT_ROOT with "/" separators.
    // A later Box upload fills box_file_id from it.
    localPath: text("local_path"),
    // The previous_text / next_text actually sent to ElevenLabs for this clip
    // (null at a lesson boundary, or when the neighbor had no translation yet).
    previousText: text("previous_text"),
    nextText: text("next_text"),
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
