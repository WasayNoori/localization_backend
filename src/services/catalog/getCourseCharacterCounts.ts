// src/services/catalog/getCourseCharacterCounts.ts
import { eq, sql } from "drizzle-orm";
import type { Database } from "../../db/client.js";
import { courses, languageTranslationSettings, languageVoiceSettings } from "../../db/schema.js";

export class CharacterCountError extends Error {
  constructor(message: string, readonly statusCode: 400 | 404) {
    super(message);
  }
}

/** Done / still to do, in characters. */
export interface CharacterProgress {
  done: number;
  remaining: number;
}

export interface LanguageCharacterCounts {
  language: string;
  /** English characters sent to DeepL (what DeepL bills). Null for "en". */
  translation: CharacterProgress | null;
  /**
   * Characters spoken (what ElevenLabs bills). `done` = text of the active clips. `remaining` = text of the
   * segments with no active clip: the translation where one exists, otherwise English × `expansionRatio`
   * (`remainingEstimated` = that part, included in `remaining`).
   */
  audio: CharacterProgress & { remainingEstimated: number };
  /** Translated ÷ English characters used for the estimate: this course's translations, else every course's, else 1. Null for "en". */
  expansionRatio: number | null;
}

export interface CourseCharacterCounts {
  courseId: string;
  countedAt: string;
  english: {
    /** All English characters: parsed segments + scripts of lessons not parsed yet. */
    characters: number;
    segments: number;
    segmentCharacters: number;
    /** Lessons with a script but no segments yet — counted from the script text. */
    unparsedLessons: number;
    unparsedCharacters: number;
    /** Lessons with neither segments nor a script — nothing to count. */
    lessonsWithoutScript: number;
  };
  languages: LanguageCharacterCounts[];
}

const LANGUAGE_CODE = /^[a-z]{2}(-[a-z]{2})?$/;
const num = (value: unknown) => Number(value ?? 0);

/**
 * Character counts for estimating DeepL/ElevenLabs cost and time, computed on demand from the current
 * segments, translations and clips (nothing stored — it's never stale). Read-only, a handful of grouped
 * queries regardless of course size. `languages` defaults to English plus every language with a voice or
 * translation setting.
 */
export async function getCourseCharacterCounts(
  db: Database,
  courseId: string,
  languages?: string[]
): Promise<CourseCharacterCounts> {
  const [course] = await db.select({ id: courses.id }).from(courses).where(eq(courses.id, courseId)).limit(1);
  if (!course) throw new CharacterCountError(`No course with id "${courseId}"`, 404);

  const codes = [...new Set((languages?.length ? languages : await configuredLanguages(db)).map((l) => l.trim().toLowerCase()))];
  const bad = codes.filter((c) => !LANGUAGE_CODE.test(c));
  if (bad.length) throw new CharacterCountError(`Not a language code: ${bad.join(", ")}`, 400);

  const courseLessonIds = sql`(select lesson_id from course_lessons where course_id = ${courseId})`;
  const languageList = sql.join(
    codes.map((c) => sql`(${c})`),
    sql`, `
  );

  const [segmentRows, lessonRows, translationRows, clipRows, missingAudioRows, globalRatioRows] = await Promise.all([
    db.execute(sql`
      select count(*) as segments, coalesce(sum(char_length(text)), 0) as characters
      from lesson_segments where lesson_id in ${courseLessonIds}`),
    db.execute(sql`
      select
        count(*) filter (where l.script_text is not null) as unparsed,
        coalesce(sum(char_length(l.script_text)), 0) as unparsed_characters,
        count(*) filter (where l.script_text is null) as without_script
      from lessons l
      where l.id in ${courseLessonIds}
        and not exists (select 1 from lesson_segments s where s.lesson_id = l.id)`),
    db.execute(sql`
      select t.target_language as language,
             sum(char_length(s.text)) as english, sum(char_length(t.translated_text)) as translated
      from segment_translations t join lesson_segments s on s.id = t.segment_id
      where s.lesson_id in ${courseLessonIds}
      group by t.target_language`),
    db.execute(sql`
      select c.language, sum(char_length(c.sentence_text)) as characters
      from tts_clips c join lesson_segments s on s.id = c.segment_id
      where s.lesson_id in ${courseLessonIds} and c.qc_status <> 'superseded'
      group by c.language`),
    // Segments the audio job would still generate (no active clip — same rule as findMissingSegments).
    db.execute(sql`
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
    db.execute(sql`
      select t.target_language as language,
             sum(char_length(t.translated_text))::float8 / nullif(sum(char_length(s.text)), 0) as ratio
      from segment_translations t join lesson_segments s on s.id = t.segment_id
      group by t.target_language`),
  ]);

  const segments = segmentRows[0] ?? {};
  const lessonCounts = lessonRows[0] ?? {};
  const segmentCharacters = num(segments.characters);
  const unparsedCharacters = num(lessonCounts.unparsed_characters);
  const byLanguage = <T extends Record<string, unknown>>(rows: T[]) => new Map(rows.map((r) => [String(r.language), r]));
  const translations = byLanguage(translationRows);
  const clips = byLanguage(clipRows);
  const missingAudio = byLanguage(missingAudioRows);
  const globalRatios = byLanguage(globalRatioRows);

  const languageCounts = codes.map((language): LanguageCharacterCounts => {
    const audioDone = num(clips.get(language)?.characters);
    const missing = missingAudio.get(language);
    if (language === "en") {
      // English is spoken as written: untranslated_english is every English segment without a clip.
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
      expansionRatio: Math.round(ratio * 100) / 100,
    };
  });

  return {
    courseId,
    countedAt: new Date().toISOString(),
    english: {
      characters: segmentCharacters + unparsedCharacters,
      segments: num(segments.segments),
      segmentCharacters,
      unparsedLessons: num(lessonCounts.unparsed),
      unparsedCharacters,
      lessonsWithoutScript: num(lessonCounts.without_script),
    },
    languages: languageCounts,
  };
}

/** English plus every language with a voice or a translation setting, English first then alphabetical. */
async function configuredLanguages(db: Database): Promise<string[]> {
  const [voices, settings] = await Promise.all([
    db.select({ language: languageVoiceSettings.targetLanguage }).from(languageVoiceSettings),
    db.select({ language: languageTranslationSettings.targetLanguage }).from(languageTranslationSettings),
  ]);
  const others = [...new Set([...voices, ...settings].map((r) => r.language.toLowerCase()))].filter((l) => l !== "en").sort();
  return ["en", ...others];
}
