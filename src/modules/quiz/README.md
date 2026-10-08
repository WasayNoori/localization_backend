# Quiz module (interim, detachable)

Translates a course's quiz questions into the target languages. Quizzes will later live in their own database;
until then this module **stores nothing about quizzes** — every run reads the source, translates and writes a
fresh file.

## Flow
1. **Source** — `MondayQuizSource`: the course's monday.com board (`courses.monday_board_id`), group
   "Quiz Questions". One item = one question; item name = lesson id (matched to the course's lessons ignoring
   case). Columns found by title: QQ ID, Quiz Question, A–D, Correct Answer, QQ Review Status, QQ Image URL.
   API token: secret `monday-api-token`.
2. **Translate** — `translateQuizQuestions`: per question, question + answer options in one DeepL request
   (glossary + formality via `translateTexts`; the question is context for its options). TRUE/FALSE → fixed
   words. Every question, whatever its review status. A blank (`____`) lost in translation is flagged; the
   optional Claude check (`ITranslationReviewer`) flags clearly wrong translations — nothing is changed.
3. **Output** — `BoxQuizWorkbookStore`: `<LANG>/Quiz Questions/<courseId> Quiz Questions <LANG>.xlsx` in the
   course's Box folder (replaced each run; Box keeps versions). Translated columns, then English, Image URL,
   Review Flag; an "About" sheet.
4. **Job** — `quizTranslationJob`: a `processing_jobs` row, type `quiz`, queued per course; poll `GET /jobs/:id`.

## Endpoints
- `GET /courses/:courseId/quiz` — reads the source and returns counts (no translation).
- `POST /courses/:courseId/quiz/translations/:lang` `{ review?: boolean }` → 202 `{ jobId, job }`.

## Seams (for the future quiz database)
`IQuizSource`, `IQuizOutputStore`, `IQuizCourseContext` (`interfaces.ts`). Add a `QuizDbSource` beside
`MondayQuizSource`; the service, job, route and console panel stay.

## Plugging in / taking out
- In: `await app.register(quizModule)` in `src/app.ts` — the module wires its own dependencies from services the
  app already exposes (translation, reviewer, Box, secrets, db). No other code imports from this folder.
- Out: delete this folder and that line (frontend: `src/lib/modules/quiz` and its line on the course page).
  `courses.monday_board_id` stays — it's general course data. The shared reviewer's `quizQuestion`/`quizAnswer`
  kinds are harmless leftovers.
