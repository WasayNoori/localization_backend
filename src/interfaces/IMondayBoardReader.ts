// src/interfaces/IMondayBoardReader.ts
// Read-only access to monday.com boards (course boards: sections as groups,
// lessons and quiz questions as items). Shared by the modules that read Monday.

export interface MondayBoard {
  id: string;
  name: string;
  columns: { id: string; title: string }[];
  /** In board order. */
  groups: { id: string; title: string }[];
}

export interface MondayItem {
  id: string;
  /** The item's name — on course boards, the lesson id. */
  name: string;
  /** `text` is Monday's display text; `value` the raw JSON (e.g. a link's url). */
  columnValues: { id: string; text: string | null; value: string | null }[];
}

export class MondayApiError extends Error {}

export interface IMondayBoardReader {
  /** Board name, columns and groups. Throws MondayApiError when the board can't be read (missing, no access, bad token). */
  readBoard(boardId: string): Promise<MondayBoard>;
  /** Every item of one group, in Monday's order (all pages). */
  readGroupItems(boardId: string, groupId: string): Promise<MondayItem[]>;
}
