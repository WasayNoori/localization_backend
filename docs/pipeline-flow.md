# Pipeline Flow

Purpose: The actual step-by-step sequence of what happens during processing,
end to end. Answers "how does a request move through the system," distinct
from architecture.md (what the pieces are) and decisions.md (why).

Should cover:
- Parse stage: Box fetch → spaCy call → transactional segment insert → parsed_at set
- Generate stage: DeepL (if needed) → ElevenLabs → Box upload → tts_clips
  insert, non-transactional per segment
- Lesson-level vs course-level scope, and why course-level fans out to the
  same lesson-level logic rather than duplicating it
- Where async/job-tracking kicks in and why
- Regeneration/superseding flow (generation_attempt, qc_status transitions)

---

## Where the job boundary sits (design, not yet built)

Lesson-level parse/generate are synchronous — call in, work happens, result
comes back in the same request. Course-level parse/generate fan out across
every lesson under a course, which has real duration and real DeepL/
ElevenLabs rate-limit exposure a single lesson doesn't — so course-level
scope is where the job boundary sits:

1. Course-level request comes in → insert a `processing_jobs` row
   (`status = 'pending'`, `progress.total` = lesson count) → respond `202`
   with the job ID immediately, without awaiting the work.
2. Work starts un-awaited in the same Node process (no external queue) →
   `status = 'running'`.
3. Fan out across the course's lessons, concurrency-limited (e.g. `p-limit`,
   a small constant like 3–5), calling the *same* lesson-level
   parse/generate function used by the synchronous lesson-level endpoint —
   no duplicated logic between the two scopes.
4. Each lesson's outcome updates `progress` (`succeeded`/`failed`)
   incrementally as it finishes, not just once at the end — `GET
   /jobs/:jobId` polling reflects real-time progress.
5. One lesson failing doesn't abort the batch — caught per-lesson, recorded
   into `progress.failed`, the rest continue.
6. On completion: `status = 'completed'` if nothing failed, else `'failed'`
   — but `progress.succeeded` still shows what did complete; partial
   success is real, useful information, not hidden by an overall failed
   status.

**Not yet built:** this fan-out logic, and the lesson-level parse function it's
meant to call, don't exist in code yet — only `processing_jobs` (the table)
and `GET /jobs/:jobId` (the read side) are implemented so far. The
lesson-level generate function described below now exists. See
`docs/decisions.md`.

---

## Generate stage: find-what's-missing resume loop

`generateLocalizationForLesson` (`src/services/generation/
generateLocalizationForLesson.ts`) resumes translation + audio generation for
one lesson + target language. It has no explicit "resume" code path — the
missing-segments query on every call **is** the resume logic, so re-invoking
it after a partial failure just picks up whatever's still missing. Backs
`POST /lessons/:lessonId/localizations/:targetLanguage/generate`; not yet
called by the course-level fan-out above.

1. Load all `lesson_segments` for the lesson, ordered by `sequence_index`.
2. Load every `tts_clips` row for those segments in this language where
   `qc_status <> 'superseded'` — this mirrors the
   `tts_clips_segment_language_active_idx` partial unique index, which
   enforces at most one active clip per segment+language at a time.
   Segments with such a row already have a clip; every other segment counts
   as missing. A segment whose only prior row is `superseded` counts as
   missing again — this is what makes regeneration resumable through the
   same query. `force` short-circuits this by superseding every active clip
   up front (DB-only), so the whole lesson counts as missing this pass —
   for intentional full regeneration, not drift recovery. `verifyBoxFiles`
   (skipped if `force` is set) instead checks each active clip's Box file
   still exists, superseding only the ones that don't.
3. For each missing segment:
   - `target_language = 'en'` → use `lesson_segments.text` directly; no
     `segment_translations` row involved, DeepL never called.
   - Otherwise, check for an existing `segment_translations` row for
     `(segment_id, target_language)`. Found → reuse `translated_text`, skip
     DeepL. Not found → call DeepL, insert the row, use the result.
   - Resolve voice/model/settings from `language_voice_settings` for this
     target language — shared by every lesson in that language, not
     per-lesson (see `docs/decisions.md`); created from
     `IVoiceSettingsProvider` defaults on first use if it doesn't exist yet,
     changed via `PUT /languages/:targetLanguage/voice-settings`, not
     anything passed to this function. Resolve the seed from the lesson's
     `lesson_localizations` row (also created for English now), created
     with a fixed default seed.
   - Call ElevenLabs with that voice/seed plus `previousText`/`nextText`
     from the adjacent segment in the same language, for prosody continuity
     across segment boundaries. A translated neighbor only contributes
     context if it's already been translated — never triggers an extra
     DeepL call just for stitching. Then run `IAudioQcService.check()` and
     insert a new `tts_clips` row with `generation_attempt` incremented from
     the prior row for this segment+language, if any. If QC passes and a
     prior row existed, mark that prior row `superseded`.
4. Each segment is processed independently and non-transactionally,
   consistent with existing generate-stage behavior — one segment throwing
   (DeepL/ElevenLabs/DB error) is caught and recorded, never rolling back or
   blocking the rest. Running the function again on a lesson already fully
   processed for a language re-queries zero missing segments and does
   nothing.

---

## Retranslation: a standalone action outside the generate loop

`POST /segments/:segmentId/translations/:targetLanguage/retranslate`
(`retranslateSegment`, `src/services/translation/retranslateSegment.ts`) is
not part of the generate-stage loop above — it's a segment-level escape
hatch for when a translation is suspect and needs another DeepL pass.
Deletes the segment's `segment_translations` row and calls DeepL again via
`translateAndStoreSegment` (the same DeepL-call-plus-insert helper the
generate loop uses for a never-yet-translated segment), but never touches
`tts_clips`. Audio regeneration from the corrected translation is a
separate, explicit call back into the generate loop above (`segmentId` +
`force: true`) — see `docs/decisions.md`.