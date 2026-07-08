# Database Schema Guide — Localization Pipeline

Covers the Postgres schema for lesson segments, translations, TTS clips, and
QC results across the spaCy → DeepL → ElevenLabs → Box pipeline. Managed via
Drizzle ORM (`src/db/schema.ts`).

Courses and Lessons themselves live in the existing LMS/catalog system — this
schema only stores `lesson_id` (and `course_id`) as external reference IDs,
not full Course/Lesson tables.

## Pipeline flow this schema supports

1. Read a lesson's English script → call spaCy → get segments → write to `lesson_segments`.
2. Send segments to DeepL for a target language → write results to `segment_translations`.
3. Call ElevenLabs on either the English segment text or a translated segment text → write results to `tts_clips`.

Steps 2 and 3 can run together or independently — a segment can exist with
no translations yet, and English audio can be generated without any
translation ever happening.

## Entity overview

```
lesson_segments (1) ──< segment_translations (many, one per target_language)
lesson_segments (1) ──< tts_clips (many, one per language actually voiced)
lesson_localizations (1) ──< tts_clips (many, only for translated audio)
voice_setting_templates (1) ──< tts_clips (many)
glossaries (looked up by target_language, not FK-joined)
```

- A **lesson_segment** is one spaCy-split sentence from a lesson's English
  script. Created once per lesson; shared across every target language.
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

## `lesson_segments`

The English spaCy output. One row per sentence per lesson.

| Column           | Type        | Notes                                                              |
|------------------|-------------|----------------------------------------------------------------------|
| `id`             | uuid, PK    | `gen_random_uuid()`                                                  |
| `course_id`      | text        | External reference ID from the LMS/catalog system                    |
| `lesson_id`      | text        | External reference ID from the LMS/catalog system                    |
| `sequence_index` | integer     | Order within the script. **Unique together with `lesson_id`.**       |
| `text`           | text        | The English sentence, as split by spaCy (post grammar-correction)    |
| `created_at`     | timestamptz | default `now()`                                                      |

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
|----------------------|-------------|------------------------------------------------------------------------|
| `id`                 | uuid, PK    | `gen_random_uuid()`                                                    |
| `segment_id`         | uuid, FK    | → `lesson_segments.id`, `on delete cascade`                            |
| `target_language`    | varchar(10) | e.g. `es`, `fr`. **Unique together with `segment_id`.**                |
| `translated_text`    | text        | DeepL's output — this is what gets sent to ElevenLabs for this language|
| `deepl_glossary_id`  | text, null  | Snapshot of the glossary ID used, from `glossaries` at translation time|
| `context_used`       | text, null  | Snapshot of the DeepL `context` param sent, if any                     |
| `billed_characters`  | integer, null | From DeepL's response, for cost tracking                             |
| `created_at`         | timestamptz | default `now()`                                                        |

**Why this exists as its own table (resolves the earlier open question):**
lets you re-run TTS from an existing translation without re-calling DeepL,
and lets you audit translation quality independently of audio quality — a
bad clip might be ElevenLabs' fault or DeepL's fault, and you want to be able
to tell which without listening to guess.

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

| Column              | Type        | Notes                                                                 |
|---------------------|-------------|------------------------------------------------------------------------|
| `id`                | uuid, PK    | `gen_random_uuid()`                                                    |
| `course_id`         | text        | External reference ID, denormalized for filtering convenience          |
| `lesson_id`         | text        | External reference ID                                                  |
| `target_language`   | varchar(10) | **Unique together with `lesson_id`.**                                  |
| `voice_id`          | text        | ElevenLabs voice ID used for this language's audio                     |
| `model_id`          | text        | e.g. `eleven_multilingual_v2`                                          |
| `tts_seed`          | integer     | Fixed seed reused across all this language's clips (best-effort only)  |
| `default_voice_settings` | jsonb  | `{ stability, similarityBoost, style, speed, useSpeakerBoost }`         |
| `box_folder_id`     | text, null  | Destination Box folder for this language's audio output                |
| `status`            | text        | `draft` \| `in_progress` \| `qc_review` \| `complete`                   |
| `created_at`        | timestamptz | default `now()`                                                        |
| `updated_at`        | timestamptz | default `now()`, bump on update                                        |

---

## `voice_setting_templates`

A named, reusable bundle of ElevenLabs settings. Lets you save several
"presets" (e.g. "Tutorial - Calm Narrator", "Tutorial - Energetic Intro") and
reference one by ID at request time instead of specifying raw values every
call.

| Column              | Type        | Notes                                                                 |
|---------------------|-------------|------------------------------------------------------------------------|
| `id`                | uuid, PK    | `gen_random_uuid()`                                                    |
| `name`              | text        | Human-readable label, e.g. `"Calm Narrator v2"`                        |
| `voice_id`          | text        | ElevenLabs voice ID                                                     |
| `model_id`          | text        | e.g. `eleven_multilingual_v2`                                          |
| `stability`         | numeric     | 0–1                                                                     |
| `similarity_boost`  | numeric     | 0–1                                                                     |
| `style`             | numeric, null | 0–1, optional                                                         |
| `speed`             | numeric, null | 0.7–1.2, optional                                                     |
| `use_speaker_boost` | boolean, null | optional                                                              |
| `is_active`         | boolean     | default `true`; soft-disable a template without deleting it            |
| `created_at`        | timestamptz | default `now()`                                                        |
| `updated_at`        | timestamptz | default `now()`, bump on update                                        |

---

## `glossaries`

DeepL manages glossary contents itself — we only store the glossary ID per
language. One glossary per target language, so this is a simple lookup
table, not a per-lesson setting.

| Column              | Type        | Notes                                                                 |
|---------------------|-------------|------------------------------------------------------------------------|
| `target_language`   | varchar(10), PK | e.g. `es`, `fr`. One row per language.                            |
| `deepl_glossary_id` | text        | DeepL's glossary ID for this language                                  |
| `updated_at`        | timestamptz | default `now()`, bump when the glossary ID changes                     |

---

## `tts_clips`

One row per generated audio segment, in either English or a target language.

| Column                  | Type        | Notes                                                              |
|-------------------------|-------------|------------------------------------------------------------------------|
| `id`                    | uuid, PK    | `gen_random_uuid()`                                                    |
| `segment_id`            | uuid, FK    | → `lesson_segments.id`, `on delete cascade`. Always set.               |
| `language`              | varchar(10) | `en` for source audio, or a target language code                       |
| `lesson_localization_id`| uuid, FK, null | → `lesson_localizations.id`. **Null for English clips** — English audio isn't a "localization." Set for translated clips. |
| `template_id`           | uuid, FK, null | → `voice_setting_templates.id`. Which template (if any) resolved `voice_settings` below |
| `sentence_text`         | text        | Snapshot of the exact text sent to ElevenLabs (English `lesson_segments.text`, or the matching `segment_translations.translated_text`) |
| `request_id`            | text, null  | Returned by ElevenLabs; feeds `previous_request_ids` on later clips     |
| `seed`                  | integer     | Snapshot of the seed actually used                                     |
| `voice_id`              | text        | Snapshot                                                                |
| `model_id`              | text        | Snapshot                                                                |
| `voice_settings`        | jsonb       | Snapshot of stability/similarity/style/speed at generation time         |
| `audio_format`          | text        | e.g. `mp3_44100_128`                                                    |
| `box_file_id`           | text, null  | Box file ID once uploaded                                               |
| `box_file_path`         | text, null  | Human-readable path, for debugging without a Box API call               |
| `qc_status`             | text        | `pending` \| `pass` \| `warn` \| `fail` \| `manual_review` \| `superseded` |
| `qc_report`             | jsonb, null | Full `QcReport` object (issues, metrics) from `IAudioQcService`         |
| `generation_attempt`    | integer     | Increments each time this segment+language is regenerated              |
| `created_at`            | timestamptz | default `now()`                                                        |

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

**Why `sequence_index` isn't duplicated here:** clip ordering comes from
`lesson_segments.sequence_index` via the `segment_id` join — no need to
repeat it.

**Why `generation_attempt` + keeping old rows (soft regeneration):** when QC
fails a clip and it's regenerated, prefer inserting a new row (same
`segment_id` + `language`, incremented `generation_attempt`) over
overwriting — you keep an audit trail of what was tried and why it failed.
Mark the previous attempt `superseded` in `qc_status` once a later attempt
passes.

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

---

## Open questions to settle before finalizing

- Do failed/superseded attempts get deleted after a retention window, or kept indefinitely for audit?