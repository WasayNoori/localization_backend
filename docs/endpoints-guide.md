# Endpoints Guide

Purpose: Practical reference for every endpoint — what it does, whether it's
sync or async, and what it calls underneath. This is what to check before
wiring up frontend or extending an endpoint.

Per endpoint, cover:
- Method + path
- Sync (returns result directly) or async (returns job ID, must poll)
- Request body shape (link to /requests-response-shapes if a detailed
  example exists there — don't duplicate full payloads here)
- Which service function/interface it calls underneath
- Notable edge cases (e.g. partial failure behavior for fan-out endpoints)

---

## `GET /jobs/:jobId`

Sync — straight read, no polling logic of its own (this endpoint IS what
you poll). Returns the `processing_jobs` row as-is: `status`, `progress`
(`{ total, succeeded, failed, skipped?, options?, error? }`), timestamps.
404 if `jobId` doesn't exist. No service/interface underneath — queries
`processing_jobs` directly. `status`: `running` → `completed` (nothing
failed) or `failed` (some lessons failed — `succeeded` still lists the rest;
or the whole job died: `progress.error`). Jobs left `running` by a server
restart are marked `failed` at startup with an "Interrupted" `error`.

Jobs are created by `POST /courses/:courseId/translations/:lang` (below).
Course-level parse and audio generate jobs aren't built yet.

---

## `POST /courses/:courseId/translations/:targetLanguage`

Async — course translation job: `startCourseTranslationJob`
(`src/services/jobs/courseTranslationJob.ts`) over `translateCourseLessons`
(`src/services/translation/translateCourseLessons.ts`), which calls the
lesson translation (`translateLessonSegments`) for each parsed lesson, one
at a time, in course order. Body (optional): `{ mode: "missing" | "all" }`.
`missing` (default) sends only segments with no translation in that
language — so a re-run continues an interrupted or partly failed job; whole
untranslated lessons also get their missing name/description. `all`
re-translates every segment. Returns `202 { jobId, job }`; poll `GET
/jobs/:jobId`. `409 { jobId, job }` if that course + language already has
an active job. `400` for `en`, `404` unknown course. Text only — never
audio. CLI equivalent (no server): `npm run course:translate -- <courseId>
fr es it [--all] [--max-seconds N]`.

---

## `POST /courses/:courseId/outputs/segments`

Sync — `writeCourseSegmentsFiles`
(`src/services/output/writeCourseSegmentsFiles.ts`) through
`ILessonOutputStore` (`LocalFolderLessonOutputStore`, root
`LOCAL_OUTPUT_ROOT`). Body `{ languages: ["en","fr",…], courseFolder? }`
(`courseFolder` relative to the root, default the course name; `..` and
absolute paths → 400). Writes, per parsed lesson and language,
`<courseFolder>/<LANG>/<lessonId>/<Language> Segments.txt`: blocks of
`001` + text, blank line between, CRLF, UTF-8 — numbers match the future
clip names `<Language> Clips/<lessonId>_<lang>_001.mp3`. A translated file
is written only when every segment is translated; otherwise listed in
`skipped`. Overwrites. `400` if `LOCAL_OUTPUT_ROOT` isn't set. CLI:
`npm run outputs:segments -- <courseId> "<courseFolder>" en fr es it`.

---

## `POST /lessons`

Sync — plain CRUD insert into `lessons`, no service/interface underneath
(same pattern as `GET /jobs/:jobId`). Body: `{ id, lessonName, boxFileId? }`.
`id` is caller-assigned and never rekeyed (see `docs/decisions.md`), so this
is how a lesson gets registered — typically once its English script is
already uploaded to Box and you have the Box file ID in hand — before
calling `POST /lessons/:lessonId/parse`. Returns the created row with `201`;
`409 Conflict` if `id` already exists.

---

## `POST /courses/import`

Sync — loads or refreshes a whole course structure in one transaction.
Logic in `importCourseStructure` (`src/services/catalog/
importCourseStructure.ts`), DB only. Body:
`{ id, courseName, description?, status?, sections: [{ sectionIndex, title,
lessons: [{ id, lessonName, description?, tags? }] }] }` —
sections and lessons in display order (array position becomes
`course_lessons.position`). Course `description`: omit to keep the stored
one, `""` to clear it. The result also has `courseUpdated` (existing course
whose name, description or status changed).

- Idempotent upsert: course by `id`, sections by `(course_id,
  section_index)`, lessons by `id`. The payload is the complete structure —
  sections and memberships missing from it are removed from this course.
  Lessons are never deleted (they may belong to other courses and own
  segments/audio).
- **Structure and metadata only — no script text.** Scripts come through
  `PUT /courses/:courseId/scripts` (the console uploads one `.txt` per
  lesson, named by lesson id). Existing scripts are never touched.
- Returns `{ courseId, sectionCount, lessonCount, lessonsCreated,
  lessonsUpdated }`.
- `400` on duplicate `sectionIndex` or a lesson id repeated within the
  course.
- `?dryRun=true` runs the same transaction and rolls it back — a preview
  that can't disagree with the real import. The result (both modes) also
  carries `dryRun`, `courseCreated`, `sectionsAdded`, `sectionsRemoved`,
  `lessonsUnchanged` and `lessonsRemovedFromCourse`; `lessonsUpdated` now
  lists only lessons whose name or description actually changed.

---

## `PUT /courses/:courseId/scripts`

Sync — scripts-only upload, `updateCourseScripts`
(`src/services/catalog/updateCourseScripts.ts`). Body:
`{ scripts: [{ lessonId, scriptText }] }`. Sets `lessons.script_text` for
lessons already in the course, bumping `script_updated_at` only when the
text actually changes. Structure and membership are untouched, so a partial
list is safe — unlike `POST /courses/import`, whose payload is the full
structure. All-or-nothing: `400` if a `lessonId` is duplicated or isn't in
this course, `404` if the course doesn't exist. Never parses. A new script
clears the typo-check marker (`script_source_text`), so the next Translate
checks it again; re-uploading the original file of a script the typo check
already fixed counts as unchanged (the fixes are kept). Returns
`{ courseId, dryRun, scriptsChanged, unchanged, needsReparse }`;
`?dryRun=true` previews without saving.

---

## `POST /courses/:courseId/scaffolding/translations/:targetLanguage`

Sync — the **scaffolding command**: `translateCourseScaffolding`
(`src/services/translation/translateScaffolding.ts`). Translates the course
name + description, every section title and every lesson's name +
description into one language, then has Claude sanity-check the results.
The course description is also part of the outline sent as context.

1. DeepL via `translateTexts` (the single DeepL path: language glossary,
   English source; ≤50 texts per request) with the course outline (all
   English titles) as `context`.
2. Claude (`ITranslationReviewer`) reviews the new translations with the
   same outline and flags only clearly wrong items — meaning lost or
   contradicted, nonsense in a CAD context, wrong language, garbled. It
   never suggests alternatives; DeepL's text is always what's stored.
3. Writes `course_translations`, `section_translations`,
   `lesson_translations` with `review_status` (`ok` / `flagged` / null)
   and `review_note`.

Body (optional): `{ mode: "missing" | "all" }` — `missing` (default) sends
only never-translated or English-changed items; `all` re-translates and
re-reviews everything except hand corrections whose English is unchanged
(see `PUT` below). Returns `{ courseId, targetLanguage, mode,
translated: {course, sections, lessons}, skipped: {…}, keptCorrections,
review: { ran, flagged, error } }`. A reviewer failure (no `anthropic-api-key`, Claude
down) is reported in `review.error` — translations are still saved,
unreviewed. `400` for `en` or an unknown `mode`, `404` unknown course,
`502` if DeepL fails (nothing written). Sync on purpose — a few batched
requests, not a per-lesson fan-out. (Replaces `POST
/courses/:courseId/titles/translations/:lang`.)

---

## `PUT /courses/:courseId/scaffolding/translations/:targetLanguage`

Sync — hand corrections: `correctScaffolding`
(`src/services/translation/correctScaffolding.ts`). Stores the text as typed
— no DeepL or Claude call. Body, every part optional:

```json
{
  "courseName": "…",
  "courseDescription": "…",
  "sections": [{ "sectionId": "<uuid>", "title": "…" }],
  "lessons": [{ "lessonId": "25Sim04_05", "lessonName": "…", "description": "…" }]
}
```

Each row gets today's English as its source snapshot (so it's current),
`edited_at = now()`, and Claude's review cleared (a person decided). A lesson
field left out keeps its current translation; a lesson with no translation
yet needs `lessonName` (and `description` if the English has one). All-or-
nothing: any bad item → `400`, nothing written. `400` also for `en`, empty
text, or ids not in this course; `404` unknown course. Returns `{ courseId,
targetLanguage, corrected: {course, sections, lessons} }`. Corrections
survive `mode: "all"`; once the English changes they're stale and the next
run replaces them like any other stale row.

---

## `GET /courses`

Sync, read-only — `listCourses` (`src/services/catalog/listCourses.ts`).
Every course with `status` (`Released` | `Draft` | null), `sectionCount`,
`lessonCount`, `segmentCount`, and `coverage[]` per language
(`translated`, `audioReady` segment counts, `lessonsComplete`). Counts come
from `getLocalizationCoverage` — three grouped queries, independent of
course size. Languages with no work yet are absent; treat as zero.

---

## `GET /courses/:courseId`

Sync, read-only — `getCourseStructure` (`src/services/catalog/
getCourseStructure.ts`). Returns ordered sections → ordered lessons, each
with `hasScript`, `boxFileId`, `parsedAt`, `segmentCount`, `parseStale`
(script changed since last parse), `localization[]` per language, `tags`,
and `translations[]` (`language`, `lessonName`, `description`, `stale`,
`review`). Sections carry `translations[]` (`language`, `title`, `stale`,
`review`) and the course carries `translations[]` (`language`,
`courseName`, `stale`, `review`) — `stale` means the English changed after
it was translated; `review` is `{ status: "ok" | "flagged" | null, note }`
from Claude's sanity check. The
course itself also carries `status`, `segmentCount` and `coverage[]` (same
shape as `GET /courses`). Lessons in the course with no section
appear in `unsectionedLessons`. 404 if `courseId` doesn't exist.

---

## `POST /lessons/:lessonId/parse`

Sync — lesson-level scope. Thin route; all logic lives in
`parseLessonSegments` (`src/services/parsing/parseLessonSegments.ts`):
reads the lesson's English script from `lessons.script_text` (falling back to
Box via `boxFileId` only when `script_text` is null), splits it via
spaCy, and rewrites `lesson_segments` for the lesson inside one transaction
(cascading to delete existing `segment_translations`/`tts_clips` — see
`docs/decisions.md` on re-parse being destructive). Requires the lesson to
have `script_text` (via `PUT /courses/:courseId/scripts`) or a `boxFileId`. Returns
`{ lessonId, segmentCount, parsedAt }`.

---

## `PUT /languages/:targetLanguage/voice-settings`

Sync — plain CRUD upsert into `language_voice_settings`, no service/
interface underneath (same pattern as `POST /lessons`). No `lessonId` —
voice configuration is per-language, shared by every lesson generating in
that language, not scoped to one lesson (see `docs/decisions.md`).

Body: `{ voiceId?, modelId?, voiceSettings? }` — every field optional,
including individual keys inside `voiceSettings` (e.g. `{ voiceSettings:
{ stability: 0.6 } }` only changes `stability`, leaves `style`/`speed`/etc.
untouched). Anything omitted keeps its current value. Creating a language
requires `voiceId` (400 otherwise — there is no default voice); `modelId`
and `voiceSettings` then start from `config/voice-defaults.ts`
(eleven_multilingual_v2, stability 0.5, similarity 0.75, style 0, speed 1).
Ranges enforced: stability / similarityBoost / style 0–1, speed 0.7–1.2.
Language code stored lowercase. Returns the resulting row. Edited in the
console under **Settings**.

`GET /languages/voice-settings` lists every configured language.
`GET /tts/options` returns the ElevenLabs account's voices (`voiceId`,
`name`, `category`, `labels`, `previewUrl`) and text-to-speech models
(`modelId`, `name`, `languages`) for the Settings page (502 if ElevenLabs
can't be reached). Generation (and `POST /tts/synthesize`, which now takes
`language`, default `en`) answers 400 for a language with no voice.

To actually regenerate a lesson with the new voice, call this first, then
`POST /lessons/:lessonId/localizations/:targetLanguage/generate` with
`force: true`.

---

## `PUT /languages/:targetLanguage/glossary`

Sync — plain CRUD upsert into `glossaries`, no service/interface underneath
(same pattern as `PUT /languages/:targetLanguage/voice-settings`). Body:
`{ deeplGlossaryId }` (required — unlike voice settings, there's only the
one field, no partial merge). One glossary per target language, looked up
by `target_language` inside `translateAndStoreSegment` whenever that
language is translated — not scoped to a lesson or segment. DeepL manages
the glossary's actual contents; this only stores the id mapping. Returns
the resulting row.

Deliberately a separate endpoint from `PUT /languages/:targetLanguage/
voice-settings` rather than folded into it — glossary (translation QC) and
voice settings (ElevenLabs tuning) are independent concerns even though
both are one-row-per-language, per the endpoint-separation rule (see
`docs/decisions.md`).

Usually you don't set ids by hand — `POST /glossaries/sync` (below) reads
them from DeepL.

---

## `POST /glossaries/sync`

Sync — `syncGlossariesFromProvider`
(`src/services/glossaries/syncGlossariesFromProvider.ts`). Lists the DeepL
account's glossaries and, for each target language, points `glossaries` at
the newest **ready** English→X glossary. Run after every glossary upload:
DeepL can't replace a glossary's entries, so an update is delete + re-create
= new id. `?dryRun=true` reports without writing. Returns `{ dryRun,
changed: [{language, from, to, name, entryCount}], unchanged: [...],
ignored: [older glossaries for the same language], notInProvider: [table
rows with no DeepL glossary — left as they are] }`. Never deletes rows.
`502` if DeepL fails. CLI: `npm run glossaries:sync` (`-- --dry-run`).

---

## `POST /translate`

Sync — stateless DeepL passthrough, no service layer beyond
`ITranslationService`. Body: `{ text, targetLanguage, context? }` — no
`glossaryId` field; the glossary for `targetLanguage` is looked up
automatically via `getGlossaryId` (`src/services/translation/
getGlossaryId.ts`, the same helper `translateAndStoreSegment` uses) and
applied if one's configured (`PUT /languages/:targetLanguage/glossary`).
Writes nothing to the database — no `segment_translations` row — and is
unrelated to the lesson-level generate flow, which persists translations as
part of resolving a lesson's segments. `502 UpstreamError` on DeepL failure.

---

## `GET /lessons/:lessonId/localizations/:language`

Sync, read-only — `getLessonLocalization` (`src/services/catalog/
getLessonLocalization.ts`). The lesson (`lessonName`, `description`,
`hasScript`, `parsedAt`, `parseStale`, `tags`, and `translation` — its
name/description in this language with `stale` and `review`, or null) and its segments in order, each with
`sourceText`, `translation` (`text`, `translatedAt`, `contextUsed`, or null),
the current non-superseded `clip` (`id`, `qcStatus`, `qcIssues`, …, or
null), a derived `status` (`not_translated` | `translated` | `audio_ready` |
`qc_failed`) and `audioStale` (clip spoken from different text than the
current translation). For `en` the source text is the translation. 404 if
the lesson doesn't exist. This is what the frontend's lesson page renders.

---

## `POST /lessons/:lessonId/translations/:targetLanguage`

Sync — lesson-level "translate this lesson". `translateLessonSegments`
(`src/services/translation/translateLessonSegments.ts`) pushes every segment
(or only `segmentIds`, body optional) through DeepL again, overwriting
existing `segment_translations` rows. Each call sends the whole English
script as DeepL `context` (`buildLessonContext`), so terminology stays
consistent while each translation still maps 1:1 to its segment.

- A whole-lesson call (no `segmentIds`) also fills the lesson's name and
  description **only if they're missing or stale** — through the same
  translate + Claude review pipeline as the scaffolding command, with the
  lesson script as DeepL context. Current titles are never re-translated
  here (that's the scaffolding command's `mode: "all"`). Response:
  `titles: { translated, flagged, error }`. A `segmentIds` call never
  touches titles.
- Text only — never touches `tts_clips`. `audioStale` lists segments whose
  active clip was spoken from different text than the new translation;
  regenerate those via the generate endpoint (`segmentId` + `force`).
- Per-segment, non-transactional: failures land in `errors[]`, the rest
  continue. Returns `{ lessonId, targetLanguage, totalSegments, translated,
  errors, audioStale }`.
- `400` if the lesson doesn't exist, has no segments, `segmentIds` aren't
  in it, or `targetLanguage` is `en`.

---

## `POST /lessons/:lessonId/localizations/:targetLanguage/generate`

Clips go to the course's Box folder (`courses.box_folder_id`) in the course
layout: `<LANG>/<lessonId>/<Language> Clips/<lessonId>_<lang>_NNN.mp3`.
Body `courseId` picks the course when the lesson is in more than one; 400 if
the lesson's course has no Box folder. (Replaces the old `boxFolderId` /
`BOX_AUDIO_FOLDER_ID` flat-folder upload.)

Sync — lesson-level scope, per the settled sync/async split (only
course-level scope is job-tracked). Thin route; all logic lives in
`generateLocalizationForLesson` (`src/services/generation/
generateLocalizationForLesson.ts`), which this just calls with the relevant
services from the container. Requires the lesson to already be parsed
(`POST /lessons/:lessonId/parse` first) — nothing to generate from
otherwise.

Body: `{ boxFolderId, segmentId?, verifyBoxFiles?, force? }`.

- `boxFolderId` — the Box folder generated clips upload into; snapshotted
  onto the `lesson_localizations` row the first time it's created for that
  lesson+language (English included), then reused from there on subsequent
  calls regardless of what's passed.
- `segmentId` — optional; restricts the call to one segment, for manual
  single-segment regeneration/debugging rather than the normal
  find-what's-missing sweep over the whole lesson.
- `verifyBoxFiles` — optional (default `false`); checks Box for each
  already-"active" clip and regenerates any whose file no longer exists.
  Off by default since it adds a Box API call per already-done segment.
  Ignored if `force` is set. See `docs/decisions.md`.
- `force` — optional (default `false`); regenerates every segment for this
  lesson+language regardless of current state (DB-only, no Box calls to
  decide — unlike `verifyBoxFiles`). For intentional full regeneration, not
  drift recovery. To regenerate with a changed voice: call
  `PUT /languages/:targetLanguage/voice-settings` first, then this with
  `force: true`.

Resumable "find what's missing" resume function, not a one-shot job — see
`docs/pipeline-flow.md` for the full query-loop. Returns a summary:
`{ lessonId, targetLanguage, totalSegments, missingSegments, succeeded, errors }`.
`errors` holds per-segment failures (DeepL/ElevenLabs/DB) that were caught
and skipped, not thrown — a non-empty `errors` array doesn't mean the whole
call failed, just that some segments didn't complete this pass. Re-calling
the same endpoint retries exactly those.

500 `InternalError` only for failures outside the per-segment loop (e.g. the
initial segment query itself failing) — this is broader than the
`502 UpstreamError` convention used by `/translate` and `/tts/synthesize`,
since failures here aren't necessarily upstream-API-shaped.

**Not yet implemented:** the course-level generate endpoint that fans out to
this per-lesson, and this doesn't yet get called by anything else in the
codebase — see `docs/decisions.md`.

---

## `GET /courses/:courseId/localizations/:targetLanguage/status`

Sync — read-only reporting, course-level scope. No DeepL/ElevenLabs calls
and no writes; it's purely a query over existing `lesson_segments`/
`tts_clips` state. 404 if `courseId` doesn't exist.

Underneath: for each lesson in the course (via `course_lessons`), calls
`findMissingSegments` (`src/services/generation/findMissingSegments.ts`) —
the same "segments missing an active `tts_clips` row for this language"
query `generateLocalizationForLesson` uses to find what's left to generate
(see `docs/pipeline-flow.md`, generate-stage section). Extracted into its
own function so this endpoint and the generate function stay in sync
without duplicating the query.

Returns:
```
{
  courseId,
  targetLanguage,
  lessons: [ { lessonId, complete, missingSegments } ],
  courseComplete   // true iff every lesson is complete
}
```
A lesson is `complete` when it has zero missing segments for that language
(a lesson with no `lesson_segments` at all — not yet parsed — is vacuously
complete, same as `generateLocalizationForLesson`'s own empty-segments
short-circuit). `courseComplete` is `true` for a course with no lessons, for
the same vacuous-truth reason.

---

## `POST /segments/:segmentId/translations/:targetLanguage/retranslate`

Sync — segment-level scope. Thin route; all logic lives in
`retranslateSegment` (`src/services/translation/retranslateSegment.ts`).
Re-translates via DeepL with the full lesson script as context and
overwrites the existing `segment_translations` row in place (no
status/audit history on that table, see `docs/decisions.md`), using
`translateAndStoreSegment` — the same DeepL-call-plus-upsert helper
`generateLocalizationForLesson` uses, extracted so the two don't duplicate
that logic. 500 `InternalError` if the segment doesn't exist, if
`targetLanguage` is `"en"` (nothing to retranslate — `lesson_segments.text`
*is* the English source), or if DeepL itself fails.

**Deliberately decoupled from audio generation** — translation QC is an
iterative, segment-at-a-time process, and re-running ElevenLabs on every
retry would be needlessly expensive. This endpoint never touches
`tts_clips`. Returns `{ segmentId, targetLanguage, translatedText,
hasActiveAudio }` — `hasActiveAudio` is informational only, `true` if an
active `tts_clips` row still exists for this segment+language (meaning it
now holds audio synthesized from the discarded translation). To regenerate
audio once satisfied with the new translation, call
`POST /lessons/:lessonId/localizations/:targetLanguage/generate` with
`segmentId` + `force: true`.

---

## `GET /clips/:clipId/audio`

Sync — streams one clip's audio bytes from Box through the API
(`clips.route.ts`, `IFileStorageService.getFileContent`), so browsers never
need Box credentials or shared links. `Content-Type` from the clip's
`audio_format` (`mp3_*` → `audio/mpeg`). 404 if the clip doesn't exist or
has no Box file; 502 if Box fails.

---

## `POST /tts/test`

Sync — thin route, calls `ttsService.synthesize` directly (same
`ITextToSpeechService` the pipeline uses). Built for manual testing against
a standalone frontend: exercising voice/model/settings combinations and
ElevenLabs' request-continuity feature without going through the
lesson/segment pipeline.

Body: `{ text, voiceId, modelId, voiceSettings, previousText?, nextText?,
seed?, previousRequestIds?, outputFormat? }` — `voiceSettings` is the full
`VoiceSettings` shape (`stability`, `similarityBoost`, `style?`,
`useSpeakerBoost?`, `speed?`). `outputFormat` defaults to `mp3_44100_192`
(see `docs/decisions.md`). `previousRequestIds` (max 3) is empty on a
caller's first request; populate it with the `requestId` returned by a
prior call to chain voice continuity across a multi-turn test session.

Response is the **raw audio bytes** (`Content-Type` from ElevenLabs,
normally `audio/mpeg`), not JSON — play or download directly from the
response body. The ElevenLabs `requestId` comes back in the `x-request-id`
response header (not the body) so it doesn't need parsing out of an audio
stream. `502 UpstreamError` (JSON) on ElevenLabs failure.

**Deliberately writes nothing** — no Box upload, no `tts_clips` row, no
lesson/segment association. Not for pipeline use; see `POST
/tts/synthesize` for the Box-backed one-off equivalent and
`POST /lessons/:lessonId/localizations/:targetLanguage/generate` for the
persisted pipeline path.
### Translation settings per language
- `GET /languages/translation-settings` — formality per configured language.
- `PUT /languages/:targetLanguage/translation-settings` `{ "formality": "more" }` — `more` formal (usted/vous/Sie), `less` informal, `prefer_*` ignored by languages without formality, `default` = DeepL decides. Sent with every DeepL request for the language. Existing translations under a different formality become stale: `npm run course:translate -- <courseId> <lang>` (missing mode) re-translates them; their audio then needs regenerating.

### Course details (create / edit)
- `POST /courses` `{ id, courseName, description?, status?, boxFolderId? }` — creates a course with details only; sections and lessons come through `POST /courses/import`. The id is the lesson-id prefix (`25Sim` → `25Sim01_01`), fixed once created (letters, digits, `-`, `_`). 201 / 400 / 409 id taken.
- `PATCH /courses/:courseId` — any of `courseName`, `description` (`""` clears), `status`, `boxFolderId` (`""` clears). 400 / 404.
- `boxFolderId` (numeric) is the course's top-level Box folder; also accepted by `POST /courses/import` (omit = unchanged) and returned by `GET /courses/:courseId`.

### Course audio job
- `POST /courses/:courseId/localizations/:targetLanguage/generate` → `202 { jobId, job }`. For one language (`en` too), into the course's Box folder: writes `<Language> Segments.txt` per lesson (unchanged files skipped), then every missing clip (`<LANG>/<lessonId>/<Language> Clips/…`). Lessons not fully translated are skipped (no DeepL). Re-running continues. Progress: `succeeded`, `failed`, `skipped`, `stats { segmentFiles, clips, characters }`. 400 no Box folder / no voice, 404, 409 active job. Audio jobs of one course run one after another in the order started (`pending` with phase `queued` while waiting); the console's "All languages" starts English first, then each target with a voice. Ends with the completeness audit below (phase `auditing`); the result is `progress.audit`, and a failed audit makes the job `failed`.
- `GET /courses/:courseId/localizations/:targetLanguage/audit` → `{ courseId, language, ok, checkedAt, lessons, lessonsOk, totals { segments, clipsInDb, clipsInBox }, problems[], warnings[] }`. Sync, read-only (Box read fresh, ~1 s per lesson). Problems, per lesson: not parsed; a segment with no active clip or more than one; a clip with no Box file id or failed QC; no lesson folder, `<Language> Segments.txt` or `<Language> Clips` folder in Box; a clip file 001…N missing in Box, or not the file the database points to. Warnings: gaps in lesson numbering (`…03_01`, `…03_03`), extra files in a Clips folder, lesson folders in Box not in the course. 400 no Box folder, 404.
- `GET /courses/:courseId/jobs` — the course's latest 20 jobs (translate + generate), newest first, so a page can resume polling.

### Box status
- `GET /storage/box/status` → `{ connected, account: { id, name, login } }` — signs in and reports the account. With the Box app's client-credentials login this is the app's service account: its `login` must be an Editor on each course folder. 502 with Box's message when sign-in fails.
