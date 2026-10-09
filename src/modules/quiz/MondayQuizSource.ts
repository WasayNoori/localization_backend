// src/modules/quiz/MondayQuizSource.ts
import { MondayApiError, type IMondayBoardReader, type MondayItem } from "../../interfaces/IMondayBoardReader.js";
import { cellText, columnIdByTitle } from "../../services/monday/MondayBoardReader.js";
import { QuizSourceError, type IQuizSource } from "./interfaces.js";
import { ANSWER_LETTERS, type QuizCourse, type QuizQuestion, type QuizSourceResult } from "./quizTypes.js";

/** The group holding the questions on every course board built from the template. */
const QUIZ_GROUP = /^\s*quiz\s+questions?\s*$/i;

/** Columns are found by title, not id, so any course board copied from the template works. */
const COLUMN_TITLES = {
  qqId: "QQ ID",
  question: "Quiz Question",
  A: "A",
  B: "B",
  C: "C",
  D: "D",
  correctAnswer: "Correct Answer",
  reviewStatus: "QQ Review Status",
  imageUrl: "QQ Image URL",
} as const;
type ColumnKey = keyof typeof COLUMN_TITLES;

/** Reads the course board's "Quiz Questions" group: one item per question, item name = lesson id. */
export class MondayQuizSource implements IQuizSource {
  constructor(private readonly monday: IMondayBoardReader) {}

  async readQuestions(course: QuizCourse): Promise<QuizSourceResult> {
    const boardId = course.mondayBoardId;
    if (!boardId) throw new QuizSourceError(`Course "${course.id}" has no Monday board — set it on the course's Edit details page`);
    try {
      const board = await this.monday.readBoard(boardId);
      const group = board.groups.find((g) => QUIZ_GROUP.test(g.title));
      if (!group) throw new QuizSourceError(`Monday board "${board.name}" has no "Quiz Questions" group`);

      const columnIds = new Map<ColumnKey, string | null>(
        (Object.entries(COLUMN_TITLES) as [ColumnKey, string][]).map(([key, title]) => [key, columnIdByTitle(board, title)])
      );
      if (!columnIds.get("question")) throw new QuizSourceError(`Monday board "${board.name}" has no "Quiz Question" column`);

      const items = await this.monday.readGroupItems(boardId, group.id);
      return {
        questions: items.map((item) => toQuestion(item, columnIds)),
        description: `monday.com board "${board.name}" (${boardId}), group "${group.title}"`,
      };
    } catch (err) {
      if (err instanceof MondayApiError) throw new QuizSourceError(err.message);
      throw err;
    }
  }
}

function toQuestion(item: MondayItem, columnIds: Map<ColumnKey, string | null>): QuizQuestion {
  const cell = (key: ColumnKey) => cellText(item, columnIds.get(key) ?? null);
  return {
    sourceItemId: item.id,
    lessonRef: item.name.trim(),
    qqId: cell("qqId"),
    question: cell("question"),
    answers: Object.fromEntries(ANSWER_LETTERS.map((l) => [l, cell(l)])) as QuizQuestion["answers"],
    correctAnswer: cell("correctAnswer"),
    reviewStatus: cell("reviewStatus"),
    imageUrl: linkUrl(item, columnIds.get("imageUrl") ?? null),
  };
}

/** Link column: the URL is in the JSON value (the text can be "label - url"). */
function linkUrl(item: MondayItem, columnId: string | null): string | null {
  const column = columnId ? item.columnValues.find((c) => c.id === columnId) : undefined;
  if (column?.value) {
    try {
      const url = (JSON.parse(column.value) as { url?: string }).url;
      if (url) return url;
    } catch {
      /* fall back to text */
    }
  }
  return cellText(item, columnId);
}
