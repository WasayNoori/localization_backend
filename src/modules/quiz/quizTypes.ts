// src/modules/quiz/quizTypes.ts
// Plain data shapes shared inside the quiz module. Nothing outside the module imports these.

export const ANSWER_LETTERS = ["A", "B", "C", "D"] as const;
export type AnswerLetter = (typeof ANSWER_LETTERS)[number];
export type Answers = Record<AnswerLetter, string | null>;

/** One quiz question as the source has it (English). */
export interface QuizQuestion {
  /** The source's own id for the row (Monday item id) — for tracing only. */
  sourceItemId: string;
  /** The lesson as the source names it (e.g. "25swsimpro02_01"); matched to the course's lesson ids ignoring case. */
  lessonRef: string;
  /** Platform question id (QQ ID). */
  qqId: string | null;
  question: string | null;
  answers: Answers;
  /** "A"–"D", or whatever the source holds ("Define Answer"). Copied unchanged. */
  correctAnswer: string | null;
  /** Keep / New / Rewrite / Remove / Need to Review — copied unchanged. */
  reviewStatus: string | null;
  /** Copied unchanged. */
  imageUrl: string | null;
}

export interface TranslatedQuizQuestion {
  source: QuizQuestion;
  /** The course's lesson id when the source's lesson matched one; otherwise the source's lessonRef. */
  lessonId: string;
  lessonName: string | null;
  question: string | null;
  answers: Answers;
  /** Claude check and mechanical checks, one line per problem; empty = nothing to look at. */
  flags: string[];
}

/** What the module needs to know about a course. */
export interface QuizCourse {
  id: string;
  courseName: string;
  boxFolderId: string | null;
  mondayBoardId: string | null;
  lessons: { id: string; name: string }[];
}

export interface QuizSourceResult {
  questions: QuizQuestion[];
  /** Human-readable origin, e.g. "monday.com board 8929465402, group Quiz Questions". */
  description: string;
}
