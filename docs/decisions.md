# Decisions

Purpose: Append-only log of settled architectural decisions and why we made
them. Answers "why is it built this way" so we don't re-litigate settled
questions later.

Format per entry:
## <short decision title>
<1-3 sentences: what was decided and why>

Do not delete old entries even if later superseded — instead add a new entry
noting the change and link back to the old one.

## `lessons.box_file_id` is nullable
A lesson can exist before its English source script is uploaded to Box, so
`box_file_id` must allow null rather than requiring it at row creation.

## Lesson-to-course is many-to-many
A lesson is an independent block and can belong to more than one course.
Modeled via a `course_lessons` join table (composite PK on
`course_id`/`lesson_id`) instead of a `course_id` column on `lessons`. See
`docs/rationale/schema-guide.md`.

## `courses`/`lessons` FK delete behavior left at status quo
No `onDelete` behavior is set on `course_lessons` → `courses`/`lessons`
FKs, so Postgres defaults to `RESTRICT` (blocking deletion of a course/lesson
still referenced). Not actively decided — kept as-is for now rather than
choosing `cascade`, since cascading could silently delete lessons (and, once
`lesson_segments`/`lesson_localizations` gain real FKs, potentially a lot of
paid DeepL/ElevenLabs work). Revisit before this matters in practice.

## Re-parse always rewrites; manual segment edits are also allowed
Re-parsing a lesson's script always rewrites `lesson_segments`, cascading to
delete existing `segment_translations`/`tts_clips` for that lesson across
every language — a deliberate, destructive, expensive-to-redo operation.
Separately, editing a `lesson_segments.text` row directly (without a full
re-parse) is also allowed.

## `courses`/`lessons` id is never rekeyed; LCMS id is a separate mapped column
Superseded the earlier assumption that `courses.id`/`lessons.id` would be
directly replaced by LCMS-issued ids once LCMS ships. Instead, `id` is our
own stable internal id, assigned manually today and never rekeyed. Added
nullable, unique `lcms_course_id`/`lcms_lesson_id` columns that get
populated with the actual LCMS id once it exists, mapped internally. This
removes any dependency on today's manual id scheme matching LCMS's future
id format — no downstream reference (`course_lessons`, `lesson_segments`,
`lesson_localizations`) ever needs to change.

## Lesson-level stays synchronous; only course-level is job-tracked
Course-level parse/generate fan out across every lesson in a course, which
has real duration and real DeepL/ElevenLabs rate-limit exposure that a
single lesson-level call doesn't — so course-level endpoints return `202`
with a `processing_jobs` row and run async, in-process (no external
queue/broker), with concurrency-limited fan-out over the existing
lesson-level logic. Lesson-level `POST /lessons/:lessonId/parse` and
lesson-level generate remain fully synchronous and never create a
`processing_jobs` row — there's no batch, so there's nothing to track.

**Blocked as of this entry:** the lesson-level parse/generate service
functions this fan-out is supposed to call do not exist yet in code (see
`docs/pipeline-flow.md` — only `lesson_segments`, `segment_translations`,
`lesson_localizations`, `tts_clips`, and their service layer are still
undocumented-as-built prose, not implemented). The `processing_jobs` table
and `GET /jobs/:jobId` can and did ship ahead of this; the actual async
job-runner that fans out to per-lesson processing is deferred until that
per-lesson processing exists to fan out to.

## Frontend selection scope: course/lesson/segment(s); only course is multi-lesson
The frontend lets a user select a course, a lesson, or specific segment(s)
and request translate or generate. Segment(s) selection is always a subset
of exactly one lesson, so it follows the same synchronous path as
single-lesson selection — **only course-level selection can ever span
multiple lessons**, so it's the only scope that needs async job tracking.
Confirms `processing_jobs.scope = 'course'` doesn't need a third value for
segment-level: segment-level is sync, same as lesson-level, not a distinct
batch scope.

## `lesson_segments`/`lesson_localizations` drop `course_id` entirely
Resolves the open question below about denormalized `course_id` on these
tables. Once a lesson can belong to multiple courses (see "Lesson-to-course
is many-to-many" above), a lesson-scoped row has no single correct course to
denormalize — there's no value that isn't potentially wrong the moment a
lesson has a second course. `course_id` is dropped from both tables;
course-scoped filtering joins through `course_lessons` on `lesson_id`
instead. Schema shipped in the migration that added `lesson_segments`,
`segment_translations`, `lesson_localizations`, `tts_clips`,
`voice_setting_templates`, and `glossaries` — see
`docs/rationale/schema-guide.md`.

## Generate-stage per-lesson function ships, resolving half of the earlier block
`generateLocalizationForLesson`
(`src/services/generation/generateLocalizationForLesson.ts`) implements the
generate-stage "find what's missing" resume logic described in
`docs/pipeline-flow.md`. This is the piece the "Lesson-level stays
synchronous" decision above was blocked on for the generate side. Still not
built: the parse-stage per-lesson function (Box → spaCy → `lesson_segments`),
the lesson-level HTTP route that calls this generate function, and the
course-level fan-out that calls it per-lesson — all deliberately deferred to
follow-up tasks, not blocked on anything new.

## Minimal `IAudioQcService` implementation: floor check only, not tiered
`BasicAudioQcService` checks only that the returned audio buffer is
non-empty and above a minimal byte-size threshold — a real, if narrow,
check, not a mock. `IAudioQcService.check()` returns `{passed, issues}`,
mapped directly to `tts_clips.qc_status` as `pass`/`fail` only —
`warn`/`manual_review` aren't produced by this implementation. Full tiered
QC (duration validation, silence detection, a richer report shape) is
separate, later work; chose not to speculatively design that shape now.

## Box auth: Developer Token for now, not client-credentials
`BoxFileStorageService` uses `BoxDeveloperTokenAuth` (a short-lived, ~1hr
token from the Box dev console), not the previously-wired `BoxCcgAuth`
(client-credentials). The dev token is what's actually available and
validated for testing right now; client-credentials was never exercised
against a real Box app. The token lives in `DummySecretsProvider` under
`box-dev-token`, not `process.env`, per this project's secrets rule. Revisit
before deploying anywhere that needs auth to outlive an hour — swap back to
`BoxCcgAuth` (or Key Vault-backed client-credentials) once that's set up and
validated.

## Fixed TTS seed (42) + previous/next-segment stitching context
`generateLocalizationForLesson` uses a constant seed (`42`) for every clip
instead of a random one per call — reproducibility is still best-effort
only (ElevenLabs doesn't guarantee seed reuse), but a shared constant is
more useful for that than a different random value each run. Also passes
`previousText`/`nextText` (the adjacent segment's text in the same
language) to ElevenLabs for prosody continuity across segment boundaries.
Neighbor text for a translated language is only included if that neighbor
already has a `segment_translations` row — resolving it never triggers an
extra DeepL call solely for stitching context; it's just omitted if not
yet translated.

## Box-existence reconciliation is opt-in, not automatic
`generateLocalizationForLesson` can verify that an already-"active" clip's
Box file still exists (`IFileStorageService.fileExists`) and, if it's gone,
supersede that row so it flows back into the normal missing-segment
regeneration path — no separate repair code path. This is gated behind an
explicit `verifyBoxFiles` option (default off), not run on every call:
checking Box for every already-done segment adds a Box API round-trip per
segment even when nothing's wrong, which defeats the point of the
missing-query being a cheap, DB-only check. Turn it on when Box/DB drift is
actually suspected (e.g. a file was deleted out of band). A genuine 404
(`BoxApiError`, has `responseInfo.statusCode`) is what counts as "gone" —
any other error (expired token, network blip, permissions — plain
`BoxSdkError`, no `responseInfo`) rethrows rather than being mistaken for a
missing file, since that would wrongly trigger regeneration.

## Box 404 detection: message-parsing, not `responseInfo.statusCode`
Refines the entry above. `box-typescript-sdk-gen`'s `BoxApiError.responseInfo`
is `undefined` at runtime in the installed version, despite the type
declarations promising `responseInfo.statusCode` — verified against both a
real 404 (never-existed file id) and a trashed-file 404 ("Item is trashed"),
both showing the same undefined `responseInfo`. The only reliable signal is
the leading HTTP status in `err.message` (e.g. `404 "Not Found"; Request
ID: "..."`), gated on `err.constructor.name === "BoxApiError"` so a
`BoxSdkError` (auth/network failures — no numeric prefix, e.g. an expired
dev token) never gets mistaken for a 404. A trashed (soft-deleted, not yet
purged) Box file also returns 404 here, which is exactly the behavior
wanted — trashed counts as gone.

## Voice settings are per-language, not per-lesson or per-lesson-shared
Superseded the earlier "voice settings live on `lesson_localizations`"
design (which itself had briefly considered a per-lesson-shared-across-
languages table). Neither matched how voices are actually managed: a voice
is picked for a *language* and reused across every lesson in that language
until it's retired/expired, then swapped for another — a language-wide
event, not a per-lesson one. New `language_voice_settings` table (PK
`target_language`, same shape as `glossaries`) holds `voice_id`/`model_id`/
`voice_settings`, shared by every lesson. `lesson_localizations` drops
`voice_id`/`model_id`/`default_voice_settings` and keeps only what's
genuinely per-lesson: `tts_seed`, `box_folder_id`, `status`. Also created
for English now (a real generation effort to track — seed/folder/status —
even without a translation effort). A future DeepL pronunciation dictionary
ID per language belongs on `language_voice_settings` too, once built.

## `force` and `voiceOverride` options on the generate function
`generateLocalizationForLesson` gained two composable options: `force`
supersedes every active clip for a lesson+language up front (DB-only, no
Box calls) so the whole lesson regenerates through the normal
missing-segment loop — for intentional full regeneration, distinct from
`verifyBoxFiles`'s drift-detection use case. `voiceOverride` updates the
`language_voice_settings` row for that language (affecting every lesson in
it going forward, not just this call) and optionally this lesson's
`tts_seed`. Pair both together to change a language's voice and immediately
regenerate one lesson with it.

## Voice settings get their own endpoint, not a generate-call option
Supersedes `voiceOverride` on `generateLocalizationForLesson`/the generate
endpoint (previous entry). Setting a language's voice has nothing to do
with any specific lesson, so routing it through
`POST /lessons/:lessonId/localizations/:targetLanguage/generate` was the
wrong shape — it required a `lessonId` for a language-wide change. Moved to
`PUT /languages/:targetLanguage/voice-settings`, plain CRUD upsert (same
pattern as `POST /lessons`), no lesson involved. Every field is optional and
merges rather than replaces — including individual keys inside
`voiceSettings` — so setting just `{ stability }` doesn't clobber
`style`/`speed`/etc.; omitted fields keep their current value, or fall back
to `IVoiceSettingsProvider` defaults if the language has no row yet. The
generate function/route dropped `voiceOverride` and the seed-override path
that came with it entirely — `force` is still how you make an existing
lesson pick up whatever's currently configured.

## Missing-segments query extracted into `findMissingSegments`
`generateLocalizationForLesson`'s "segments missing an active `tts_clips`
row for this lesson+language" query moved into its own function
(`src/services/generation/findMissingSegments.ts`), so `GET
/courses/:courseId/localizations/:targetLanguage/status` (a new, read-only,
no-DeepL/no-ElevenLabs reporting endpoint) can reuse the exact same
"what's missing" logic instead of reimplementing it. `force`/`verifyBoxFiles`
(which mutate `tts_clips` rows) stay inside `generateLocalizationForLesson`
only — the shared function itself is a plain, side-effect-free query.

## Retranslation is a standalone segment-level action, decoupled from audio
`POST /segments/:segmentId/translations/:targetLanguage/retranslate`
(`retranslateSegment`, `src/services/translation/retranslateSegment.ts`)
hard-deletes the segment's `segment_translations` row and calls DeepL again,
but never touches `tts_clips`. Translation QC is expected to be iterative
and segment-at-a-time (infrequent, but real) — coupling it to audio
regeneration (as the generate endpoint's `force` does for `tts_clips`) would
mean paying for an ElevenLabs call on every QC retry, which is needlessly
expensive. Regenerating audio from the corrected translation is a separate,
explicit follow-up call to the existing generate endpoint (`segmentId` +
`force: true`). The DeepL-call-plus-insert logic itself was extracted into
`translateAndStoreSegment` (`src/services/translation/
translateAndStoreSegment.ts`) so `generateLocalizationForLesson` and
`retranslateSegment` share it rather than duplicating it — mirrors the
earlier `findMissingSegments` extraction.

## Glossary upsert gets its own endpoint, not folded into voice settings
`PUT /languages/:targetLanguage/glossary` (`language-glossary.route.ts`) is
a separate endpoint from `PUT /languages/:targetLanguage/voice-settings`,
even though both are one-row-per-language upserts and could have been
merged into a single "language settings" call. Glossary (DeepL/translation
QC) and voice settings (ElevenLabs tuning) are independent concerns/actors —
same reasoning that already justified splitting voice settings out of the
lesson-level generate endpoint (see "Voice settings get their own endpoint"
above) applies here too. Previously, `glossaries` rows had no upsert path in
code at all — populated out-of-band directly in the DB.

## `POST /translate` resolves its own glossary; `glossaryId` dropped from the body
Previously `/translate` accepted an optional caller-supplied `glossaryId`,
passed straight through to DeepL. Dropped in favor of always looking up
`glossaries` by `targetLanguage` internally (via the new `getGlossaryId`
helper, `src/services/translation/getGlossaryId.ts`) — a target language has
exactly one glossary (see `PUT /languages/:targetLanguage/glossary`), so
requiring the caller to already know and pass its id was redundant and
error-prone. `getGlossaryId` was extracted out of
`translateAndStoreSegment`'s inline query so both it and `/translate` share
the same lookup rather than duplicating it.

## Open questions (not yet settled)
- Do failed/superseded `tts_clips` attempts get deleted after a retention
  window, or kept indefinitely for audit?
- Manual `lesson_segments.text` edits have no mechanism to flag dependent
  `segment_translations`/`tts_clips` as stale — a direct edit silently
  leaves old translations/audio pointing at now-incorrect English text.
  Needs a design (e.g. an `edited_at` timestamp, or invalidating dependent
  rows on edit) before this capability ships.
- The generate-stage resume function's missing-segments query only treats
  `superseded` as "not active" (matching the `tts_clips` partial unique
  index) — a segment whose only clip is `qc_status = 'fail'` is *not*
  re-picked-up automatically. Retrying an explicit failure is presumed to be
  a separate, manual action (mark the failed row `superseded`, then
  re-invoke) rather than something this function does on its own. Not yet
  validated against how the frontend actually wants failure retries to work.