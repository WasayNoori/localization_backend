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
(`{ succeeded, failed, total }`), timestamps. 404 if `jobId` doesn't exist.
No service/interface underneath — queries `processing_jobs` directly.

**Not yet documented here:** the course-level `POST
/courses/:courseId/parse` and `POST
/courses/:courseId/localizations/:targetLanguage/generate` endpoints that
create the jobs this reads. Those, and the lesson-level parse endpoint they
fan out to, aren't implemented yet — see `docs/decisions.md`.

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

## `POST /lessons/:lessonId/parse`

Sync — lesson-level scope. Thin route; all logic lives in
`parseLessonSegments` (`src/services/parsing/parseLessonSegments.ts`):
fetches the lesson's English script from Box via `boxFileId`, splits it via
spaCy, and rewrites `lesson_segments` for the lesson inside one transaction
(cascading to delete existing `segment_translations`/`tts_clips` — see
`docs/decisions.md` on re-parse being destructive). Requires the lesson to
already exist with a `boxFileId` set (`POST /lessons` first). Returns
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
untouched). Anything omitted keeps its current value; if the language has
no row yet, omitted fields fall back to `IVoiceSettingsProvider` defaults.
Returns the resulting row.

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

## `POST /lessons/:lessonId/localizations/:targetLanguage/generate`

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
Deletes the existing `segment_translations` row for this segment+language
(hard delete — no status/audit column on that table today, see
`docs/decisions.md`) and re-translates via DeepL, using
`translateAndStoreSegment` — the same DeepL-call-plus-insert helper
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