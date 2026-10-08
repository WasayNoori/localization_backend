// src/modules/quiz/translateQuizQuestions.ts
import type { Database } from "../../db/client.js";
import type { ITranslationReviewer, ReviewItem } from "../../interfaces/ITranslationReviewer.js";
import type { ITranslationService } from "../../interfaces/ITranslationService.js";
import { translateTexts } from "../../services/translation/translateTexts.js";
import { ANSWER_LETTERS, type AnswerLetter, type QuizCourse, type QuizQuestion, type TranslatedQuizQuestion } from "./quizTypes.js";

export interface TranslateQuizDeps {
  db: Database;
  translationService: ITranslationService;
  /** Optional second opinion (Claude) — flags clearly wrong translations, never changes them. */
  translationReviewer?: ITranslationReviewer;
}

export interface TranslateQuizStats {
  questions: number;
  /** Questions sent to DeepL. */
  translated: number;
  /** Characters sent to DeepL. */
  characters: number;
  /** Questions with at least one flag. */
  flagged: number;
}

/** True/false answers use fixed words — never sent to DeepL. */
const TRUE_FALSE: Record<string, { true: string; false: string }> = {
  fr: { true: "Vrai", false: "Faux" },
  es: { true: "Verdadero", false: "Falso" },
  it: { true: "Vero", false: "Falso" },
  de: { true: "Wahr", false: "Falsch" },
  pt: { true: "Verdadeiro", false: "Falso" },
};
const BLANK = /_{3,}/;

/**
 * Translates every question of a course's quiz into one language, in source
 * order. Each question and its answer options go to DeepL in one request, with
 * the question as context for the options, so they agree with it. The target
 * language's glossary and formality apply (translateTexts). TRUE/FALSE answers
 * use fixed words. Questions are translated whatever their review status — the
 * status is carried through for whoever loads the platform.
 */
export async function translateQuizQuestions(
  deps: TranslateQuizDeps,
  course: QuizCourse,
  questions: QuizQuestion[],
  language: string,
  options: { review: boolean; onProgress?: (done: number) => void | Promise<void> }
): Promise<{ questions: TranslatedQuizQuestion[]; stats: TranslateQuizStats }> {
  const lessonById = new Map(course.lessons.map((l) => [l.id.toLowerCase(), l]));
  const stats: TranslateQuizStats = { questions: questions.length, translated: 0, characters: 0, flagged: 0 };
  const out: TranslatedQuizQuestion[] = [];

  for (const [i, q] of questions.entries()) {
    const lesson = lessonById.get(q.lessonRef.toLowerCase());
    const row: TranslatedQuizQuestion = {
      source: q,
      lessonId: lesson?.id ?? q.lessonRef,
      lessonName: lesson?.name ?? null,
      question: null,
      answers: { A: null, B: null, C: null, D: null },
      flags: lesson ? [] : [`Lesson "${q.lessonRef}" isn't in course ${course.id}`],
    };

    // Fixed words for TRUE/FALSE; everything else goes to DeepL with the question.
    const toTranslate: { key: "question" | AnswerLetter; text: string }[] = [];
    if (q.question) toTranslate.push({ key: "question", text: q.question });
    for (const letter of ANSWER_LETTERS) {
      const text = q.answers[letter];
      if (!text) continue;
      const fixed = trueFalse(text, language);
      if (fixed !== null) row.answers[letter] = fixed;
      else toTranslate.push({ key: letter, text });
    }

    if (toTranslate.length) {
      const context = [
        `Quiz question in the SOLIDWORKS training course "${course.courseName}"${lesson ? `, lesson "${lesson.name}"` : ""}.`,
        q.question ? `Question: ${q.question}` : "",
      ]
        .filter(Boolean)
        .join(" ");
      const { translatedTexts } = await translateTexts(deps, { texts: toTranslate.map((t) => t.text), targetLanguage: language, context });
      toTranslate.forEach((t, k) => {
        if (t.key === "question") row.question = translatedTexts[k];
        else row.answers[t.key] = translatedTexts[k];
      });
      stats.translated++;
      stats.characters += toTranslate.reduce((n, t) => n + t.text.length, 0);
    }

    // Mechanical check: a fill-in blank must survive translation.
    if (q.question && BLANK.test(q.question) && row.question && !BLANK.test(row.question)) {
      row.flags.push("Question: the blank (____) is missing from the translation");
    }
    out.push(row);
    await options.onProgress?.(i + 1);
  }

  if (options.review && deps.translationReviewer) await reviewQuiz(deps.translationReviewer, course, out, language);
  stats.flagged = out.filter((r) => r.flags.length).length;
  return { questions: out, stats };
}

/** Claude's second opinion on questions and answer options (fixed TRUE/FALSE words aren't sent). */
async function reviewQuiz(reviewer: ITranslationReviewer, course: QuizCourse, rows: TranslatedQuizQuestion[], language: string) {
  const items: ReviewItem[] = [];
  rows.forEach((row, i) => {
    const q = row.source;
    if (q.question && row.question) items.push({ key: `${i}:Q`, kind: "quizQuestion", source: q.question, translation: row.question });
    for (const letter of ANSWER_LETTERS) {
      const source = q.answers[letter];
      const translation = row.answers[letter];
      if (source && translation && trueFalse(source, language) === null) {
        items.push({ key: `${i}:${letter}`, kind: "quizAnswer", source, translation });
      }
    }
  });
  if (!items.length) return;
  const context = [`Course: ${course.courseName}`, ...course.lessons.map((l) => `- ${l.id}: ${l.name}`)].join("\n");
  const verdicts = await reviewer.review({ targetLanguage: language, context, items });
  for (const v of verdicts) {
    if (!v.flagged) continue;
    const [index, part] = v.key.split(":");
    const row = rows[Number(index)];
    if (row) row.flags.push(`${part === "Q" ? "Question" : `Answer ${part}`}: ${v.reason ?? "flagged by the review"}`);
  }
}

/** The fixed word for a TRUE/FALSE answer in the target language, keeping its case style; null when it isn't one. */
function trueFalse(text: string, language: string): string | null {
  const value = text.trim().toLowerCase();
  if (value !== "true" && value !== "false") return null;
  const words = TRUE_FALSE[language];
  if (!words) return null; // unknown language → let DeepL do it
  const word = words[value as "true" | "false"];
  return text.trim() === text.trim().toUpperCase() ? word.toUpperCase() : word;
}
