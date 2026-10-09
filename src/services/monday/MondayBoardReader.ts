// src/services/monday/MondayBoardReader.ts
import type { ISecretsProvider } from "../../interfaces/ISecretsProvider.js";
import { MondayApiError, type IMondayBoardReader, type MondayBoard, type MondayItem } from "../../interfaces/IMondayBoardReader.js";

const MONDAY_API_URL = "https://api.monday.com/v2";
const REQUEST_TIMEOUT_MS = 30_000;
const PAGE_SIZE = 500;
const ITEM_FIELDS = "id name column_values { id text value }";

type RawItem = { id: string; name: string; column_values: MondayItem["columnValues"] };

/** monday.com GraphQL API, read-only. Token: secret "monday-api-key". Retries 429/5xx twice; 30 s per request. */
export class MondayBoardReader implements IMondayBoardReader {
  constructor(private readonly secretsProvider: ISecretsProvider) {}

  async readBoard(boardId: string): Promise<MondayBoard> {
    const data = await this.query<{ boards: MondayBoard[] }>(
      `query ($board: [ID!]) { boards(ids: $board) { id name columns { id title } groups { id title } } }`,
      { board: [boardId] }
    );
    const board = data.boards[0];
    if (!board) throw new MondayApiError(`Monday board ${boardId} wasn't found, or the API key can't see it`);
    return board;
  }

  async readGroupItems(boardId: string, groupId: string): Promise<MondayItem[]> {
    const first = await this.query<{ boards: { groups: { items_page: { cursor: string | null; items: RawItem[] } }[] }[] }>(
      `query ($board: [ID!], $group: [String]) {
         boards(ids: $board) { groups(ids: $group) { items_page(limit: ${PAGE_SIZE}) { cursor items { ${ITEM_FIELDS} } } } }
       }`,
      { board: [boardId], group: [groupId] }
    );
    const page = first.boards[0]?.groups[0]?.items_page;
    const items = [...(page?.items ?? [])];
    let cursor = page?.cursor ?? null;
    while (cursor) {
      const next = await this.query<{ next_items_page: { cursor: string | null; items: RawItem[] } }>(
        `query ($cursor: String!) { next_items_page(limit: ${PAGE_SIZE}, cursor: $cursor) { cursor items { ${ITEM_FIELDS} } } }`,
        { cursor }
      );
      items.push(...next.next_items_page.items);
      cursor = next.next_items_page.cursor;
    }
    return items.map((i) => ({ id: i.id, name: i.name, columnValues: i.column_values }));
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
        throw new MondayApiError(`monday.com API: ${message}`);
      }
      return body.data;
    }
  }
}

/** Finds a column by title (case-insensitive, trimmed); null when the board has no such column. */
export function columnIdByTitle(board: MondayBoard, title: string): string | null {
  const wanted = title.trim().toLowerCase();
  return board.columns.find((c) => c.title.trim().toLowerCase() === wanted)?.id ?? null;
}

/** An item's display text for a column id; null when empty or the column is missing. */
export function cellText(item: MondayItem, columnId: string | null): string | null {
  if (!columnId) return null;
  const text = item.columnValues.find((c) => c.id === columnId)?.text?.trim();
  return text ? text : null;
}
