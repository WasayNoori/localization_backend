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