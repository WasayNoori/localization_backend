# Database Schema Guide

Purpose: Reference documentation for the Postgres schema (Drizzle ORM).
Covers every table, its columns, and the rationale behind non-obvious design
decisions (why a field is nullable, why something is snapshotted vs joined,
etc.).

Rules for this file:
- No inline SQL migration snippets — describe structure in prose/tables only.
- No open/unresolved design questions embedded here — if something is still
  undecided, it belongs in decisions.md or a scratch note, not here.
- Keep this file settled and clean; treat it as the source of truth once a
  table ships.

  # Database Schema Guide — Localization Pipeline

Covers the Postgres schema for lesson segments, translations, TTS clips, and
QC results across the spaCy → DeepL → ElevenLabs → Box pipeline. Managed via
Drizzle ORM (`src/db/schema.ts`).

`courses` and `lessons` are **real, interim tables** in this schema — a
stand-in for the LCMS system another team is currently building. They are
not placeholders: once LCMS ships, these tables remain. `id` is our own
stable internal id and is **never rekeyed** — a separate nullable
`lcms_course_id`/`lcms_lesson_id` column absorbs the actual LCMS-issued id
once it exists, mapped internally. `box_file_id` / `parsed_at` stay
pipeline-owned regardless of LCMS, since they're facts about this
pipeline's processing of a lesson, not about the course catalog itself.

## Pipeline flow this schema supports

1. Look up a lesson's `box_file_id` from `lessons` → fetch the English
   script from Box → call spaCy → get segments → write to `lesson_segments`
   (transactional) → set `lessons.parsed_at`.
2. Send segments to DeepL for a target language → write results to
   `segment_translations`.
3. Call ElevenLabs on either the English segment text or a translated
   segment text → write results to `tts_clips`.

Steps 2 and 3 can run together or independently — a segment can exist with
no translations yet, and English audio can be generated without any
translation ever happening.

Processing can be triggered at the **lesson level** (single lesson,
synchronous) or the **course level** (all lessons under a course, async —
see `processing_jobs` below). Course-level endpoints fan out to the same
underlying per-lesson service functions; there is no separate/duplicated
processing logic for course scope.

## Entity overview

```
courses (many) ──< course_lessons >── (many) lessons
lessons (1) ──< lesson_segments (many)
lesson_segments (1) ──< segment_translations (many, one per target_language)
lesson_segments (1) ──< tts_clips (many, one per language actually voiced)
lesson_localizations (1) ──< tts_clips (many, only for translated audio)
voice_setting_templates (1) ──< tts_clips (many)
glossaries (looked up by target_language, not FK-joined)
```

- A **course** is a real, interim record standing in for LCMS course
  metadata.
- A **lesson** is an independent block that can belong to more than one
  course (via `course_lessons`), and holds the pointer to its English
  source script in Box.
- A **lesson_segment** is one ~300–400 character chunk from a lesson's
  English script, as grouped by spaCy (may span multiple sentences).
  Created once per lesson; shared across every target language.
- A **segment_translation** is DeepL's output for one segment in one target
  language. Independent of audio — exists whether or not a clip was ever
  generated from it.
- A **lesson_localization** tracks the *translation/audio effort* for one
  lesson into one target language (status, seed, default voice settings). It
  does not hold segment text itself.
- A **tts_clip** is one generated audio segment — from either the English
  segment text directly, or a `segment_translation`'s text.
- A **voice_setting_template** is a named, reusable bundle of ElevenLabs
  settings, selectable by ID.

---

## `courses`

Real, interim table — stands in for the LCMS system another team is
building. Remains after LCMS ships; `id` itself never changes.

| Column          | Type        | Notes                                                                   |
|-----------------|-------------|--------------------------------------------------------------------------|
| `id`            | text, PK    | Our own stable internal id, assigned manually today. Never rekeyed — downstream references to this id never need to change |
| `course_name`   | text        |                                                                          |
| `lcms_course_id`| text, null, unique | Mapping to the LCMS-issued course id, populated once LCMS ships. Null until then |
| `created_at`    | timestamptz | default `now()`                                                         |
| `updated_at`    | timestamptz | default `now()`, bump on update                                         |

---

## `lessons`

Real, interim table — same reasoning as `courses`. `id` is the same
`lesson_id` string already referenced (as a bare string, no FK) by
`lesson_segments.lesson_id` and `lesson_localizations.lesson_id`. A lesson
is an independent block, not owned by a single course — see
`course_lessons` below for how it attaches to one or more courses.

| Column          | Type              | Notes                                                              |
|-----------------|-------------------|------------------------------------------------------------------------|
| `id`            | text, PK          | This IS the `lesson_id` value used elsewhere in the schema — our own stable internal id, never rekeyed |
| `lesson_name`   | text              |                                                                          |
| `box_file_id`   | text, null        | Box file ID of the English source script. Nullable — a lesson can exist before its script is uploaded |
| `lcms_lesson_id`| text, null, unique | Mapping to the LCMS-issued lesson id, populated once LCMS ships. Null until then |
| `parsed_at`     | timestamptz, null | Set (and overwritten) every time this lesson's script is parsed. Re-parsing always rewrites `lesson_segments` for this lesson |
| `created_at`    | timestamptz       | default `now()`                                                         |
| `updated_at`    | timestamptz       | default `now()`, bump on update                                        |

**Why no translation/audio/QC status fields here:** those are per-language
facts and already belong to `lesson_localizations.status` and
`tts_clips.qc_status`. Rolling them up onto `lessons` would duplicate state
that already lives at the correct grain elsewhere.

**Why `lesson_segments`/`lesson_localizations` don't get an FK to `lessons`
yet:** they keep referencing `lesson_id` as a bare string for now, unchanged
— this avoids coupling internal pipeline tables to a table whose backing
source (manual today, LCMS-synced later) will change.

**Re-parse and manual segment edits (both allowed):** re-parsing a lesson's
script always rewrites `lesson_segments` — old rows are replaced, which
cascades (`on delete cascade`) to delete existing `segment_translations` and
`tts_clips` for that lesson across every language. This is a deliberate,
destructive, expensive-to-redo operation (re-parsing wipes all translation
and audio work for the lesson) — treat re-parse as a heavy action, not a
casual one. Separately, a single `lesson_segments.text` row can be edited
directly without a full re-parse. **Open gap, not yet resolved:** there is
no mechanism to flag `segment_translations`/`tts_clips` as stale when the
underlying segment text is edited this way — a direct edit silently leaves
old translations/audio pointing at now-incorrect English text with no
signal to regenerate. Needs a design (e.g. an `edited_at` timestamp, or
invalidating dependent rows on edit) before this capability ships.

**Post-LCMS expectation:** `lessons`/`courses` become local shadow/reference
tables synced or looked up against LCMS, with `lcms_lesson_id`/
`lcms_course_id` populated to record the mapping. Internal `id` is never
rekeyed, so `course_lessons` and every downstream reference (`lesson_id` in
`lesson_segments`, `lesson_localizations`) needs no migration at all.
`box_file_id`, `parsed_at`, and everything downstream are unaffected by that
transition — none of it was ever LCMS's concern.

---

## `course_lessons`

Join table for the many-to-many relationship between `courses` and
`lessons` — a lesson is an independent block and can be reused across more
than one course.

| Column      | Type     | Notes                                    |
|-------------|----------|--------------------------------------------|
| `course_id` | text, FK | → `courses.id`. Part of composite PK        |
| `lesson_id` | text, FK | → `lessons.id`. Part of composite PK        |

Composite primary key `(course_id, lesson_id)` — prevents the same lesson
being linked to the same course twice; no surrogate `id` needed for a pure
join table.

**Resolved:** `lesson_segments`/`lesson_localizations` do not have a
`course_id` column — see those tables below. A lesson-scoped row has no
single correct course to denormalize once a lesson can belong to multiple
courses; course-based filtering for segments/clips joins through
`course_lessons` on `lesson_id` instead. See `docs/decisions.md`.

**Also unresolved:** no ordering/sequence column here, so a lesson's
position within a given course isn't modeled yet.

---

## `lesson_segments`

The English spaCy output. One row per ~300–400 character segment per
lesson — **not one row per sentence.** `spacy-nlp-service`'s `/process`
endpoint groups sentences to target that character range: a segment may be
a single long sentence, or several short sentences grouped together.

| Column           | Type        | Notes                                                              |
|------------------|-------------|------------------------------------------------------------------------|
| `id`             | uuid, PK    | `gen_random_uuid()`                                                   |
| `lesson_id`      | text        | Bare string reference to `lessons.id` (no FK yet — see above)         |
| `sequence_index` | integer     | Order within the script. **Unique together with `lesson_id`.**       |
| `text`           | text        | One ~300–400 character segment, as split by spaCy (post grammar-correction) — may span multiple sentences |
| `created_at`     | timestamptz | default `now()`                                                       |

**Why this is separate from translations and clips:** the English text is
the one thing that doesn't change per target language — every translation
and every clip (English or translated) ultimately traces back to one of
these rows. Storing it once avoids re-deriving "what did segment 7 actually
say" differently depending on which language you're looking at.

---

## `segment_translations`

DeepL's output for one segment, in one target language. Exists independently
of whether audio has been generated yet.

| Column               | Type        | Notes                                                              |
|-----------------------|-------------|------------------------------------------------------------------------|
| `id`                 | uuid, PK    | `gen_random_uuid()`                                                    |
| `segment_id`         | uuid, FK    | → `lesson_segments.id`, `on delete cascade`                            |
| `target_language`    | varchar(10) | e.g. `es`, `fr`. **Unique together with `segment_id`.**                |
| `translated_text`    | text        | DeepL's output — this is what gets sent to ElevenLabs for this language|
| `deepl_glossary_id`  | text, null  | Snapshot of the glossary ID used, from `glossaries` at translation time|
| `context_used`       | text, null  | Snapshot of the DeepL `context` param sent, if any                     |
| `billed_characters`  | integer, null | From DeepL's response, for cost tracking                             |
| `created_at`         | timestamptz | default `now()`                                                        |

**Why this exists as its own table:** lets you re-run TTS from an existing
translation without re-calling DeepL, and lets you audit translation quality
independently of audio quality — a bad clip might be ElevenLabs' fault or
DeepL's fault, and you want to be able to tell which without listening to
guess.

**Why `deepl_glossary_id` is snapshotted here too, even though `glossaries`
is a global lookup:** if the glossary is later updated for that language,
this row still shows what was actually in effect when *this* sentence was
translated — same reasoning as snapshotting voice settings on `tts_clips`.

---

## `lesson_localizations`

Tracks the translation/audio effort for one lesson into one target language.
Created when a translation pass is kicked off for a given lesson + language.
**Not used for English audio** — English clips reference `lesson_segments`
directly with no localization row (see `tts_clips` below).

| Column                    | Type        | Notes                                                              |
|---------------------------|-------------|------------------------------------------------------------------------|
| `id`                      | uuid, PK    | `gen_random_uuid()`                                                    |
| `lesson_id`               | text        | Bare string reference to `lessons.id`                                 |
| `target_language`         | varchar(10) | **Unique together with `lesson_id`.**                                  |
| `voice_id`                | text        | ElevenLabs voice ID used for this language's audio                    |
| `model_id`                | text        | e.g. `eleven_multilingual_v2`                                         |
| `tts_seed`                | integer     | Fixed seed reused across all this language's clips (best-effort only) |
| `default_voice_settings`  | jsonb       | `{ stability, similarityBoost, style, speed, useSpeakerBoost }`        |
| `box_folder_id`           | text, null  | Destination Box folder for this language's audio output               |
| `status`                  | text        | `draft` \| `in_progress` \| `qc_review` \| `complete`                  |
| `created_at`              | timestamptz | default `now()`                                                        |
| `updated_at`              | timestamptz | default `now()`, bump on update                                       |

---

## `voice_setting_templates`

A named, reusable bundle of ElevenLabs settings. Lets you save several
"presets" (e.g. "Tutorial - Calm Narrator", "Tutorial - Energetic Intro") and
reference one by ID at request time instead of specifying raw values every
call.

| Column              | Type          | Notes                                                                 |
|---------------------|---------------|--------------------------------------------------------------------------|
| `id`                | uuid, PK      | `gen_random_uuid()`                                                    |
| `name`              | text          | Human-readable label, e.g. `"Calm Narrator v2"`                        |
| `voice_id`          | text          | ElevenLabs voice ID                                                     |
| `model_id`          | text          | e.g. `eleven_multilingual_v2`                                          |
| `stability`         | numeric       | 0–1                                                                     |
| `similarity_boost`  | numeric       | 0–1                                                                     |
| `style`             | numeric, null | 0–1, optional                                                          |
| `speed`             | numeric, null | 0.7–1.2, optional                                                      |
| `use_speaker_boost` | boolean, null | optional                                                               |
| `is_active`         | boolean       | default `true`; soft-disable a template without deleting it            |
| `created_at`        | timestamptz   | default `now()`                                                        |
| `updated_at`        | timestamptz   | default `now()`, bump on update                                        |

---

## `glossaries`

DeepL manages glossary contents itself — we only store the glossary ID per
language. One glossary per target language, so this is a simple lookup
table, not a per-lesson setting.

| Column              | Type            | Notes                                                             |
|---------------------|-----------------|------------------------------------------------------------------------|
| `target_language`   | varchar(10), PK | e.g. `es`, `fr`. One row per language.                            |
| `deepl_glossary_id` | text            | DeepL's glossary ID for this language                                  |
| `updated_at`        | timestamptz     | default `now()`, bump when the glossary ID changes                    |

---

## `tts_clips`

One row per generated audio segment, in either English or a target language.

| Column                  | Type           | Notes                                                              |
|-------------------------|----------------|------------------------------------------------------------------------|
| `id`                    | uuid, PK       | `gen_random_uuid()`                                                    |
| `segment_id`            | uuid, FK       | → `lesson_segments.id`, `on delete cascade`. Always set.               |
| `language`              | varchar(10)    | `en` for source audio, or a target language code                       |
| `lesson_localization_id`| uuid, FK, null | → `lesson_localizations.id`. **Null for English clips** — English audio isn't a "localization." Set for translated clips. |
| `template_id`           | uuid, FK, null | → `voice_setting_templates.id`. Which template (if any) resolved `voice_settings` below |
| `sentence_text`         | text           | Snapshot of the exact text sent to ElevenLabs (English `lesson_segments.text`, or the matching `segment_translations.translated_text`) |
| `request_id`            | text, null     | Returned by ElevenLabs; feeds `previous_request_ids` on later clips    |
| `seed`                  | integer        | Snapshot of the seed actually used                                     |
| `voice_id`              | text           | Snapshot                                                                |
| `model_id`              | text           | Snapshot                                                                |
| `voice_settings`        | jsonb          | Snapshot of stability/similarity/style/speed at generation time        |
| `audio_format`          | text           | e.g. `mp3_44100_128`                                                    |
| `box_file_id`           | text, null     | Box file ID once uploaded                                              |
| `box_file_path`         | text, null     | Human-readable path, for debugging without a Box API call             |
| `qc_status`             | text           | `pending` \| `pass` \| `warn` \| `fail` \| `manual_review` \| `superseded` |
| `qc_report`             | jsonb, null    | Full `QcReport` object (issues, metrics) from `IAudioQcService`        |
| `generation_attempt`    | integer        | Increments each time this segment+language is regenerated             |
| `created_at`            | timestamptz    | default `now()`                                                        |

**Why `sentence_text` is still snapshotted here, even though it's derivable
by joining `segment_id` + `language` back to `lesson_segments` or
`segment_translations`:** the source segment or its translation could be
edited later. The snapshot preserves exactly what was spoken in *this* clip,
independent of later edits upstream.

**Why `lesson_localization_id` is nullable:** English clips are generated
directly from `lesson_segments` with no translation step and no per-language
tracking effort — there's nothing to localize. Only translated clips belong
to a `lesson_localization` (for shared seed, voice defaults, and status
tracking across that language's full clip set).

**Why `segment_id` + `language` together (not just a translation FK):** this
lets one clips table serve both English and translated audio without a
nullable-vs-not split between two different foreign keys. To find the
matching text: `language = 'en'` → join `lesson_segments`; otherwise → join
`segment_translations` on `(segment_id, target_language = language)`.

**Why `generation_attempt` + keeping old rows (soft regeneration):** when QC
fails a clip and it's regenerated, prefer inserting a new row (same
`segment_id` + `language`, incremented `generation_attempt`) over
overwriting — you keep an audit trail of what was tried and why it failed.
Mark the previous attempt `superseded` in `qc_status` once a later attempt
passes. The same insert-new-row pattern applies to manual single-segment
regeneration requested from the UI, not just automatic QC-driven retries.

---

## `processing_jobs`

Tracks long-running, course-level fan-out operations (parse or generate
across all lessons in a course). **Lesson-level parse/generate stay
synchronous and do not use this table** — only course-level scope needs
job tracking, since it's the only case involving multi-lesson batches with
real duration and rate-limit concerns (DeepL/ElevenLabs). In-process only —
no external queue/broker.

| Column            | Type        | Notes                                                                 |
|-------------------|-------------|--------------------------------------------------------------------------|
| `id`              | uuid, PK    | `gen_random_uuid()`                                                    |
| `scope`           | text        | `'course'` only for now. Stored as text, not a hardcoded enum, in case lesson-level scope is ever job-tracked too |
| `target_id`       | text        | The course ID this job runs against                                    |
| `type`            | text        | `'parse'` \| `'generate'`                                              |
| `target_language` | text, null  | Set when `type = 'generate'`; null for `'parse'`                       |
| `status`          | text        | `'pending'` \| `'running'` \| `'completed'` \| `'failed'`               |
| `progress`        | jsonb       | `{ succeeded: string[], failed: { lessonId: string, error: string }[], total: number }` |
| `created_at`      | timestamptz | default `now()`                                                        |
| `updated_at`      | timestamptz | default `now()`, bumped as `progress`/`status` change                  |

**Why `status = 'failed'` even when some lessons succeeded:** the batch is
considered failed if anything failed, but `progress.succeeded` still shows
exactly what completed — partial success is expected and useful
information, not hidden by the failed status.

**Why one row per job, not one row per lesson:** `progress` holds the full
per-lesson breakdown as jsonb rather than a child table, since nothing
outside the job itself ever queries a single lesson's outcome
independently of its job.

See `docs/decisions.md` for the rationale on why lesson-level stays sync
and only course-level is job-tracked.

---

## Suggested indexes

```sql
create unique index lesson_segments_lesson_sequence_idx
  on lesson_segments (lesson_id, sequence_index);

create unique index segment_translations_segment_language_idx
  on segment_translations (segment_id, target_language);

create unique index lesson_localizations_lesson_language_idx
  on lesson_localizations (lesson_id, target_language);

create unique index tts_clips_segment_language_active_idx
  on tts_clips (segment_id, language)
  where qc_status <> 'superseded';

create index tts_clips_lesson_localization_id_idx on tts_clips (lesson_localization_id);
create index tts_clips_qc_status_idx on tts_clips (qc_status);
```

Open design questions have moved to `docs/decisions.md`, per this file's own
rule against embedding unresolved questions here.