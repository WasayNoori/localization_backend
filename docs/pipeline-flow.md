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

## Where the job boundary sits (translation built; parse/generate jobs not yet)

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

**Built for translation:** `POST /courses/:courseId/translations/:lang`
(one job per language) — differs from the sketch above in two ways: lessons
run one at a time (each already makes one DeepL request per segment;
languages run as separate jobs in parallel), and progress also has
`skipped` (not parsed / already translated). Startup marks jobs a restart
interrupted as `failed`. **Not yet built:** course-level parse and generate
jobs. Loading + parsing a whole course's scripts is a CLI for now
(`npm run scripts:load -- <courseId> <folder> --parse`).

## Outputs stage (local folder until Box is decided)

After translation, `POST /courses/:courseId/outputs/segments` (or `npm run
outputs:segments`) writes `<Language> Segments.txt` per lesson under
`LOCAL_OUTPUT_ROOT/<courseFolder>/<Language>/<lessonId>/`. Audio lands
beside it in `<Language> Clips/` (POC, until Box is registered):

```
npm run audio:generate -- <courseId> "<courseFolder>" fr es it [--lessons a,b] [--estimate] [--max-seconds N]
```

**Box (the normal path):** the course page's "Generate audio" (or `POST
/courses/:courseId/localizations/:lang/generate`) runs the same thing as a
job into the course's Box folder: Segments.txt for every lesson first, then
the missing clips, with `BoxClipStore`. The CLI below remains for local runs.

`generateCourseAudio` calls the lesson-level generate loop below for each
lesson (languages in parallel, lessons one at a time) with a
`LocalFolderClipStore`; `tts_clips.local_path` records each file and
`box_file_id` is backfilled once the clips are uploaded to Box.
`--estimate` counts missing clips and characters without calling
ElevenLabs. Lessons not fully translated are skipped (no DeepL calls).

---

## Load + parse stage

Scripts from files: `npm run scripts:load -- <courseId> <folder> --proofread
[--dry-run] --parse`. Proofreading runs before anything is saved (see
decisions.md, "Scripts are proofread…"); its report is
`<folder>/_proofread-report.md`.

1. `POST /courses/import` upserts course → sections → lessons, storing each
   lesson's full English script in `lessons.script_text` (no parsing).
2. `POST /lessons/:lessonId/parse` reads `script_text` (Box via
   `box_file_id` only as a fallback), calls spaCy, and rewrites
   `lesson_segments` in one transaction, setting `parsed_at`.
3. If a later import changes a parsed lesson's script, it's listed in
   `needsReparse` and shows `parseStale` on `GET /courses/:courseId` —
   re-parse stays an explicit call because it deletes translations/audio.

---

## Scaffolding stage (per language, before scripts)

1. Glossary for the language is in place (`PUT /languages/:lang/glossary`).
2. `POST /courses/:courseId/scaffolding/translations/:lang` — DeepL
   translates course name, section titles, lesson names/descriptions
   (missing/stale by default; `mode: "all"` for everything), then Claude
   flags clearly wrong items. A human reviews the flags.
3. Scripts follow (import → parse → lesson translation → audio). Lesson
   translation only fills a lesson's titles if they're missing or stale.

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
   in scope up front (DB-only; just that segment's clip when `segmentId` is
   given), so everything in scope counts as missing this pass —
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
     per-lesson (see `docs/decisions.md`), via `IVoiceSettingsProvider`
     (`DbVoiceSettingsProvider`); a language with no row fails the call
     (no default voice). Set in Settings / `PUT
     /languages/:targetLanguage/voice-settings`, not
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

## Translation: lesson-level and segment-level, outside the generate loop

`POST /lessons/:lessonId/translations/:targetLanguage` re-translates every
segment (or a selected subset), overwriting existing rows, with the whole
lesson script sent to DeepL as context. Text only — `audioStale` in the
response says which clips now need regenerating. The single-segment
version is below.

`POST /segments/:segmentId/translations/:targetLanguage/retranslate`
(`retranslateSegment`, `src/services/translation/retranslateSegment.ts`) is
not part of the generate-stage loop above — it's a segment-level escape
hatch for when a translation is suspect and needs another DeepL pass.
Overwrites the segment's `segment_translations` row by calling DeepL again via
`translateAndStoreSegment` (the same DeepL-call-plus-insert helper the
generate loop uses for a never-yet-translated segment), but never touches
`tts_clips`. Audio regeneration from the corrected translation is a
separate, explicit call back into the generate loop above (`segmentId` +
`force: true`) — see `docs/decisions.md`.