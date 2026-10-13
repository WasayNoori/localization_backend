var __defProp = Object.defineProperty;
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
};

// src/db/client.ts
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";

// src/db/schema.ts
var schema_exports = {};
__export(schema_exports, {
  courseLessons: () => courseLessons,
  courseSections: () => courseSections,
  courseTranslations: () => courseTranslations,
  courses: () => courses,
  glossaries: () => glossaries,
  languageTranslationSettings: () => languageTranslationSettings,
  languageVoiceSettings: () => languageVoiceSettings,
  lessonLocalizations: () => lessonLocalizations,
  lessonSegments: () => lessonSegments,
  lessonTranslations: () => lessonTranslations,
  lessons: () => lessons,
  processingJobs: () => processingJobs,
  sectionTranslations: () => sectionTranslations,
  segmentTranslations: () => segmentTranslations,
  ttsClips: () => ttsClips,
  voiceSettingTemplates: () => voiceSettingTemplates
});
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
  index
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
var courses = pgTable("courses", {
  id: text("id").primaryKey(),
  courseName: text("course_name").notNull(),
  // Learner-facing course description; part of the scaffolding. Null = none.
  description: text("description"),
  // 'Released' | 'Draft'. Nullable: owned by the BI app / LCMS, set via
  // POST /courses/import until a catalog sync exists.
  status: text("status"),
  lcmsCourseId: text("lcms_course_id").unique(),
  // Top-level Box folder for this course's outputs. The pipeline creates
  // <LANG>/<lessonId>/<Language> Clips/ under it. Null = not set (audio
  // can't go to Box for this course yet).
  boxFolderId: text("box_folder_id"),
  // The course's monday.com board (lessons, statuses, quiz questions live
  // there). Numeric board id; null = not set.
  mondayBoardId: text("monday_board_id"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow()
});
var lessons = pgTable("lessons", {
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
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow()
});
var courseSections = pgTable(
  "course_sections",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    courseId: text("course_id").notNull().references(() => courses.id),
    // 1-based display order within the course.
    sectionIndex: integer("section_index").notNull(),
    title: text("title").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow()
  },
  (table) => ({
    courseSectionIdx: uniqueIndex("course_sections_course_index_idx").on(table.courseId, table.sectionIndex)
  })
);
var courseLessons = pgTable(
  "course_lessons",
  {
    courseId: text("course_id").notNull().references(() => courses.id),
    lessonId: text("lesson_id").notNull().references(() => lessons.id),
    // Nullable so pre-existing membership rows stay valid; set by course import.
    sectionId: uuid("section_id").references(() => courseSections.id),
    // 1-based order of the lesson within its section.
    position: integer("position")
  },
  (table) => ({
    pk: primaryKey({ columns: [table.courseId, table.lessonId] })
  })
);
var courseTranslations = pgTable(
  "course_translations",
  {
    courseId: text("course_id").notNull().references(() => courses.id, { onDelete: "cascade" }),
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
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow()
  },
  (table) => ({
    pk: primaryKey({ columns: [table.courseId, table.targetLanguage] })
  })
);
var sectionTranslations = pgTable(
  "section_translations",
  {
    sectionId: uuid("section_id").notNull().references(() => courseSections.id, { onDelete: "cascade" }),
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
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow()
  },
  (table) => ({
    pk: primaryKey({ columns: [table.sectionId, table.targetLanguage] })
  })
);
var lessonTranslations = pgTable(
  "lesson_translations",
  {
    lessonId: text("lesson_id").notNull().references(() => lessons.id, { onDelete: "cascade" }),
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
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow()
  },
  (table) => ({
    pk: primaryKey({ columns: [table.lessonId, table.targetLanguage] })
  })
);
var processingJobs = pgTable("processing_jobs", {
  id: uuid("id").primaryKey().defaultRandom(),
  // 'course' only for now; stored as text (not a hardcoded enum) in case
  // lesson-level scope is ever job-tracked too.
  scope: text("scope").notNull(),
  targetId: text("target_id").notNull(),
  type: text("type").notNull(),
  // Set when type = 'translate' | 'generate'; null for 'parse'.
  targetLanguage: text("target_language"),
  status: text("status").notNull(),
  progress: jsonb("progress").$type().notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow()
});
var lessonSegments = pgTable(
  "lesson_segments",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    lessonId: text("lesson_id").notNull(),
    sequenceIndex: integer("sequence_index").notNull(),
    text: text("text").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow()
  },
  (table) => ({
    lessonSequenceIdx: uniqueIndex("lesson_segments_lesson_sequence_idx").on(
      table.lessonId,
      table.sequenceIndex
    )
  })
);
var segmentTranslations = pgTable(
  "segment_translations",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    segmentId: uuid("segment_id").notNull().references(() => lessonSegments.id, { onDelete: "cascade" }),
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
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow()
  },
  (table) => ({
    segmentLanguageIdx: uniqueIndex("segment_translations_segment_language_idx").on(
      table.segmentId,
      table.targetLanguage
    )
  })
);
var lessonLocalizations = pgTable(
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
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow()
  },
  (table) => ({
    lessonLanguageIdx: uniqueIndex("lesson_localizations_lesson_language_idx").on(
      table.lessonId,
      table.targetLanguage
    )
  })
);
var voiceSettingTemplates = pgTable("voice_setting_templates", {
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
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow()
});
var glossaries = pgTable("glossaries", {
  targetLanguage: varchar("target_language", { length: 10 }).primaryKey(),
  deeplGlossaryId: text("deepl_glossary_id").notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow()
});
var languageTranslationSettings = pgTable("language_translation_settings", {
  targetLanguage: varchar("target_language", { length: 10 }).primaryKey(),
  // 'default' | 'more' | 'less' | 'prefer_more' | 'prefer_less' (ITranslationService.Formality)
  formality: text("formality").notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow()
});
var languageVoiceSettings = pgTable("language_voice_settings", {
  targetLanguage: varchar("target_language", { length: 10 }).primaryKey(),
  voiceId: text("voice_id").notNull(),
  modelId: text("model_id").notNull(),
  voiceSettings: jsonb("voice_settings").$type().notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow()
});
var ttsClips = pgTable(
  "tts_clips",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    segmentId: uuid("segment_id").notNull().references(() => lessonSegments.id, { onDelete: "cascade" }),
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
    voiceSettings: jsonb("voice_settings").$type().notNull(),
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
    qcReport: jsonb("qc_report").$type(),
    generationAttempt: integer("generation_attempt").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow()
  },
  (table) => ({
    // Enforces at most one active (non-superseded) clip per segment+language
    // at a time — the invariant the generate-stage resume logic relies on.
    activeClipIdx: uniqueIndex("tts_clips_segment_language_active_idx").on(table.segmentId, table.language).where(sql`${table.qcStatus} <> 'superseded'`),
    lessonLocalizationIdx: index("tts_clips_lesson_localization_id_idx").on(
      table.lessonLocalizationId
    ),
    qcStatusIdx: index("tts_clips_qc_status_idx").on(table.qcStatus)
  })
);

// src/db/client.ts
function createDbClient(connectionString) {
  const client = postgres(connectionString);
  return drizzle(client, { schema: schema_exports });
}

// src/services/catalog/getCourseCharacterCounts.ts
import { eq, sql as sql2 } from "drizzle-orm";
var CharacterCountError = class extends Error {
  constructor(message, statusCode) {
    super(message);
    this.statusCode = statusCode;
  }
};
var LANGUAGE_CODE = /^[a-z]{2}(-[a-z]{2})?$/;
var num = (value) => Number(value ?? 0);
async function getCourseCharacterCounts(db2, courseId, languages) {
  const [course] = await db2.select({ id: courses.id }).from(courses).where(eq(courses.id, courseId)).limit(1);
  if (!course)
    throw new CharacterCountError(`No course with id "${courseId}"`, 404);
  const codes = [...new Set((languages?.length ? languages : await configuredLanguages(db2)).map((l) => l.trim().toLowerCase()))];
  const bad = codes.filter((c) => !LANGUAGE_CODE.test(c));
  if (bad.length)
    throw new CharacterCountError(`Not a language code: ${bad.join(", ")}`, 400);
  const courseLessonIds = sql2`(select lesson_id from course_lessons where course_id = ${courseId})`;
  const languageList = sql2.join(
    codes.map((c) => sql2`(${c})`),
    sql2`, `
  );
  const [segmentRows, lessonRows, translationRows, clipRows, missingAudioRows, globalRatioRows] = await Promise.all([
    db2.execute(sql2`
      select count(*) as segments, coalesce(sum(char_length(text)), 0) as characters
      from lesson_segments where lesson_id in ${courseLessonIds}`),
    db2.execute(sql2`
      select
        count(*) filter (where l.script_text is not null) as unparsed,
        coalesce(sum(char_length(l.script_text)), 0) as unparsed_characters,
        count(*) filter (where l.script_text is null) as without_script
      from lessons l
      where l.id in ${courseLessonIds}
        and not exists (select 1 from lesson_segments s where s.lesson_id = l.id)`),
    db2.execute(sql2`
      select t.target_language as language,
             sum(char_length(s.text)) as english, sum(char_length(t.translated_text)) as translated
      from segment_translations t join lesson_segments s on s.id = t.segment_id
      where s.lesson_id in ${courseLessonIds}
      group by t.target_language`),
    db2.execute(sql2`
      select c.language, sum(char_length(c.sentence_text)) as characters
      from tts_clips c join lesson_segments s on s.id = c.segment_id
      where s.lesson_id in ${courseLessonIds} and c.qc_status <> 'superseded'
      group by c.language`),
    // Segments the audio job would still generate (no active clip — same rule as findMissingSegments).
    db2.execute(sql2`
      select l.lang as language,
             coalesce(sum(char_length(t.translated_text)), 0) as translated,
             coalesce(sum(char_length(s.text)) filter (where t.id is null), 0) as untranslated_english
      from lesson_segments s
      cross join (values ${languageList}) as l(lang)
      left join segment_translations t on t.segment_id = s.id and t.target_language = l.lang
      where s.lesson_id in ${courseLessonIds}
        and not exists (
          select 1 from tts_clips c
          where c.segment_id = s.id and c.language = l.lang and c.qc_status <> 'superseded')
      group by l.lang`),
    db2.execute(sql2`
      select t.target_language as language,
             sum(char_length(t.translated_text))::float8 / nullif(sum(char_length(s.text)), 0) as ratio
      from segment_translations t join lesson_segments s on s.id = t.segment_id
      group by t.target_language`)
  ]);
  const segments = segmentRows[0] ?? {};
  const lessonCounts = lessonRows[0] ?? {};
  const segmentCharacters = num(segments.characters);
  const unparsedCharacters = num(lessonCounts.unparsed_characters);
  const byLanguage = (rows) => new Map(rows.map((r) => [String(r.language), r]));
  const translations = byLanguage(translationRows);
  const clips = byLanguage(clipRows);
  const missingAudio = byLanguage(missingAudioRows);
  const globalRatios = byLanguage(globalRatioRows);
  const languageCounts = codes.map((language) => {
    const audioDone = num(clips.get(language)?.characters);
    const missing = missingAudio.get(language);
    if (language === "en") {
      const remaining = num(missing?.untranslated_english) + unparsedCharacters;
      return { language, translation: null, audio: { done: audioDone, remaining, remainingEstimated: 0 }, expansionRatio: null };
    }
    const translated = translations.get(language);
    const translatedEnglish = num(translated?.english);
    const courseRatio = translatedEnglish > 0 ? num(translated?.translated) / translatedEnglish : null;
    const ratio = courseRatio ?? (num(globalRatios.get(language)?.ratio) || 1);
    const estimated = Math.round((num(missing?.untranslated_english) + unparsedCharacters) * ratio);
    return {
      language,
      translation: { done: translatedEnglish, remaining: segmentCharacters - translatedEnglish + unparsedCharacters },
      audio: { done: audioDone, remaining: num(missing?.translated) + estimated, remainingEstimated: estimated },
      expansionRatio: Math.round(ratio * 100) / 100
    };
  });
  return {
    courseId,
    countedAt: (/* @__PURE__ */ new Date()).toISOString(),
    english: {
      characters: segmentCharacters + unparsedCharacters,
      segments: num(segments.segments),
      segmentCharacters,
      unparsedLessons: num(lessonCounts.unparsed),
      unparsedCharacters,
      lessonsWithoutScript: num(lessonCounts.without_script)
    },
    languages: languageCounts
  };
}
async function configuredLanguages(db2) {
  const [voices, settings] = await Promise.all([
    db2.select({ language: languageVoiceSettings.targetLanguage }).from(languageVoiceSettings),
    db2.select({ language: languageTranslationSettings.targetLanguage }).from(languageTranslationSettings)
  ]);
  const others = [...new Set([...voices, ...settings].map((r) => r.language.toLowerCase()))].filter((l) => l !== "en").sort();
  return ["en", ...others];
}

// ../../../tmp/claude-0/t/chk.ts
import { buildSecretsProvider } from "./scripts/vm-secrets.js";
var db = createDbClient(await buildSecretsProvider().getSecret("database-url"));
for (const id of ["25SWSimPro", "25PDMPro"]) {
  const c = await getCourseCharacterCounts(db, id, ["en", "fr", "es", "it", "de"]);
  console.log(id, JSON.stringify(c.english));
  for (const l of c.languages)
    console.log(" ", l.language, JSON.stringify(l.translation), JSON.stringify(l.audio), l.expansionRatio);
}
process.exit(0);
