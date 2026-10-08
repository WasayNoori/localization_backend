// src/modules/quiz/interfaces.ts
// The quiz module's own seams. Today: questions come from the course's Monday
// board and go out as an .xlsx per language in Box. When quizzes get their own
// database, add another IQuizSource (and, if needed, IQuizOutputStore); the
// service, job and route stay as they are.
import type { QuizCourse, QuizSourceResult, TranslatedQuizQuestion } from "./quizTypes.js";

/** Where a course's quiz questions come from. */
export interface IQuizSource {
  /** All questions in source order. Throws QuizSourceError when the course has no source or it can't be read. */
  readQuestions(course: QuizCourse): Promise<QuizSourceResult>;
}

export interface QuizOutput {
  course: QuizCourse;
  language: string;
  questions: TranslatedQuizQuestion[];
  sourceDescription: string;
  generatedAt: Date;
}

/** Where translated quizzes are written. */
export interface IQuizOutputStore {
  /** Writes (or replaces) the language's quiz file; returns where it went. */
  write(output: QuizOutput): Promise<{ fileId: string; path: string }>;
}

/** Read-only course facts the module needs — kept behind a port so the module never reaches into other tables directly. */
export interface IQuizCourseContext {
  getCourse(courseId: string): Promise<QuizCourse | null>;
}

export class QuizSourceError extends Error {}
