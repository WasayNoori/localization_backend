// src/modules/quiz/MondayQuizSource.ts
import type { ISecretsProvider } from "../../interfaces/ISecretsProvider.js";
import { QuizSourceError, type IQuizSource } from "./interfaces.js";
import { ANSWER_LETTERS, type QuizCourse, type QuizQuestion, type QuizSourceResult } from "./quizTypes.js";

const MONDAY_API_URL = "https://api.monday.com/v2";
const REQUEST_TIMEOUT_MS = 30_000;
const PAGE_SIZE = 500;
/** The group holding the questions on every course board built from the template. */
const QUIZ_GROUP = /^\s*quiz\s+questions?\s*$/i;

/**
 * Columns are found by title, not id, so any course board copied from the
 * template works. Titles compare case-insensitively.
 */
const COLUMN_TITLES = {
  qqId: "qq id",
  question: "quiz question",
  A: "a",
  B: "b",
  C: "c",
  D: "d",
  correctAnswer: "correct answer",
  reviewStatus: "qq review status",
  imageUrl: "qq image url",
} as const;
type ColumnKey = keyof typeof COLUMN_TITLES;

interface MondayItem {
  id: string;
  name: string;
  column_values: { id: string; text: string | null; value: string | null }[];
}

/**
 * Reads the course board's "Quiz Questions" group: one item per question,
 * item name = lesson id. Monday API token: secret "monday-api-key".
 */
export class MondayQuizSource implements IQuizSource {
  constructor(private readonly secretsProvider: ISecretsProvider) {}

  async readQuestions(course: QuizCourse): Promise<QuizSourceResult> {
    const boardId = course.mondayBoardId;
    if (!boardId) throw new QuizSourceError(`Course "${course.id}" has no Monday board — set it on the course's Edit details page`);

    const board = await this.query<{
      boards: { id: string; name: string; columns: { id: string; title: string }[]; groups: { id: string; title: string }[] }[];
    }>(`query ($board: [ID!]) { boards(ids: $board) { id name columns { id title } groups { id title } } }`, { board: [boardId] });
    const info = board.boards[0];
    if (!info) throw new QuizSourceError(`Monday board ${boardId} wasn't found, or the API token can't see it`);

    const group = info.groups.find((g) => QUIZ_GROUP.test(g.title));
    if (!group) throw new QuizSourceError(`Monday board "${info.name}" has no "Quiz Questions" group`);

    const columnIds = new Map<ColumnKey, string>();
    for (const [key, title] of Object.entries(COLUMN_TITLES) as [ColumnKey, string][]) {
      const column = info.columns.find((c) => c.title.trim().toLowerCase() === title);
      if (column) columnIds.set(key, column.id);
    }
    if (!columnIds.has("question")) throw new QuizSourceError(`Monday board "${info.name}" has no "Quiz Question" column`);

    const items = await this.groupItems(boardId, group.id);
    const questions = items.map((item) => toQuestion(item, columnIds));
    return { questions, description: `monday.com board "${info.name}" (${boardId}), group "${group.title}"` };
  }

  private async groupItems(boardId: string, groupId: string): Promise<MondayItem[]> {
    const itemFields = "id name column_values { id text value }";
    const first = await this.query<{ boards: { groups: { items_page: { cursor: string | null; items: MondayItem[] } }[] }[] }>(
      `query ($board: [ID!], $group: [String]) {
         boards(ids: $board) { groups(ids: $group) { items_page(limit: ${PAGE_SIZE}) { cursor items { ${itemFields} } } } }
       }`,
      { board: [boardId], group: [groupId] }
    );
    const page = first.boards[0]?.groups[0]?.items_page;
    const items = [...(page?.items ?? [])];
    let cursor = page?.cursor ?? null;
    while (cursor) {
      const next = await this.query<{ next_items_page: { cursor: string | null; items: MondayItem[] } }>(
        `query ($cursor: String!) { next_items_page(limit: ${PAGE_SIZE}, cursor: $cursor) { cursor items { ${itemFields} } } }`,
        { cursor }
      );
      items.push(...next.next_items_page.items);
      cursor = next.next_items_page.cursor;
    }
    return items;
  }

  private async query<T>(query: string, variables: Record<string, unknown>): Promise<T> {
    const token = await this.secretsProvider.getSecret("monday-api-key");
    for (let attempt = 1; ; attempt++) {
      const response = await fetch(MONDAY_API_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: token },
        body: JSON.stringify({ query, variables }),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
      if ((response.status === 429 || response.status >= 500) && attempt < 3) {
        await new Promise((r) => setTimeout(r, 2000 * attempt));
        continue;
      }
      const body = (await response.json().catch(() => null)) as { data?: T; errors?: { message: string }[]; error_message?: string } | null;
      if (!response.ok || !body?.data || body.errors?.length) {
        const message = body?.errors?.map((e) => e.message).join("; ") ?? body?.error_message ?? `HTTP ${response.status}`;
        throw new QuizSourceError(`monday.com API: ${message}`);
      }
      return body.data;
    }
  }
}

function toQuestion(item: MondayItem, columnIds: Map<ColumnKey, string>): QuizQuestion {
  const cell = (key: ColumnKey): string | null => {
    const id = columnIds.get(key);
    const column = id ? item.column_values.find((c) => c.id === id) : undefined;
    if (!column) return null;
    if (key === "imageUrl" && column.value) {
      // Link column: the URL is in the JSON value; text can be "label - url".
      try {
        const url = (JSON.parse(column.value) as { url?: string }).url;
        if (url) return url;
      } catch {
        /* fall back to text */
      }
    }
    const text = column.text?.trim();
    return text ? text : null;
  };
  return {
    sourceItemId: item.id,
    lessonRef: item.name.trim(),
    qqId: cell("qqId"),
    question: cell("question"),
    answers: Object.fromEntries(ANSWER_LETTERS.map((l) => [l, cell(l)])) as QuizQuestion["answers"],
    correctAnswer: cell("correctAnswer"),
    reviewStatus: cell("reviewStatus"),
    imageUrl: cell("imageUrl"),
  };
}
