# Monday outline import (detachable)

Imports a course's sections and lessons from its monday.com board (`courses.monday_board_id`) — a one-way import
you trigger, not a sync (the BI app may own course metadata later).

- Groups named `Section N - Title` → sections (N = section index). Other groups (e.g. "Quiz Questions") are ignored.
- Items in those groups → lessons: item name = lesson id; columns **Lesson Name** (required), **Lesson Description**,
  **Lesson Level Tags** (comma-separated), found by title. Lessons sorted by id within a section (numeric-aware).
- Lesson id casing (Monday and the course id may differ): an existing lesson matching ignoring case keeps its id;
  else an id starting with the course id (any case) takes the course id's casing; else kept as is and reported.
- Then the regular structure import (`importCourseStructure`) — same rules, same `dryRun` preview. Course name,
  description and status are left as stored. Scripts aren't touched.

Endpoint: `POST /courses/:courseId/import/monday?dryRun=true|false`.
Uses the shared `IMondayBoardReader` (`app.mondayBoardReader`).
To remove: delete this folder and its line in `src/app.ts` (frontend: the "Monday board" mode on the Import page).
