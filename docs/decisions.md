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

## Lesson audio bitrate raised to 192kbps; `outputFormat` request field fixed
`AUDIO_FORMAT` in `generateLocalizationForLesson.ts` moved from
`mp3_44100_128` to `mp3_44100_192` (account confirmed on ElevenLabs `pro`
tier, which supports 192kbps). While making the change, found
`ElevenLabsTtsService.synthesize` accepted `request.outputFormat` on the
interface but never appended it to the request URL — ElevenLabs was always
returning its default bitrate regardless of what callers passed. Fixed by
appending `?output_format=...` to the URL when the field is set.

## `POST /tts/test` — raw-audio test endpoint, no persistence
Added a second TTS ad-hoc route alongside `/tts/synthesize` specifically for
exercising a standalone test frontend (voice/model/settings/continuity
experiments). Kept as its own endpoint rather than a mode flag on
`/tts/synthesize` since the actor and intent differ (manual testing vs.
Box-backed one-off generation) and the response shape differs (raw audio
bytes vs. a Box file record). Deliberately writes nothing — no Box upload,
no `tts_clips` row — since it's throwaway by design. `voiceId`/`modelId` are
explicit body fields (not pulled from `IVoiceSettingsProvider`) so the
frontend can freely test combinations without touching stored defaults.
`previousRequestIds` reuses the existing `SynthesizeSpeechRequest` field:
empty on a caller's first request, then populated with the `requestId`
returned by the prior call (returned via `x-request-id` response header,
since the body is raw audio) to chain ElevenLabs voice continuity across a
test session.

## Script text lives in the DB; Box file ID kept as a future pointer
The Box folder structure isn't settled yet, so the full English script is
stored on `lessons.script_text` and is what `parseLessonSegments` reads.
`box_file_id` stays as a nullable column to point at the script's Box file
once the structure is decided; parse only falls back to Box when
`script_text` is null. `script_updated_at` is bumped only when the text
actually changes, so `script_updated_at > parsed_at` flags segments cut from
an older script — this covers whole-script edits; per-segment manual edits
(open question below) are still unflagged.

## Sections modeled as `course_sections`; placement on `course_lessons`
Courses have ordered sections, each with ordered lessons. Sections belong to
one course (`course_sections`, unique on `course_id, section_index`).
Because a lesson can belong to several courses, *where* it sits (section +
position) is a fact about the membership, so `section_id`/`position` live on
`course_lessons`, not `lessons`. This also resolves the earlier "no ordering
column on `course_lessons`" gap.

## Course structure is imported in one call
`POST /courses/import` takes the full course → sections → lessons (+
scripts) tree and upserts it in one transaction, rather than separate CRUD
calls per entity — same actor, one action (endpoint separation rule). The
payload is authoritative for membership and sections; lessons are never
deleted by an import. Import never parses: re-parse is destructive, so it
stays an explicit call, guided by the `needsReparse` list in the response.
When the BI app / LCMS becomes the source, a catalog client can build this
same payload.

## Lesson translation re-translates every segment, with full-lesson DeepL context
"Request translation" on a lesson means push all of its segments (or a
selected subset) through DeepL again and overwrite the stored translations —
`POST /lessons/:lessonId/translations/:targetLanguage`. Unlike generate, it
never reuses existing rows, and it never touches audio (same decoupling as
retranslation). Every DeepL call, from this endpoint, retranslate and the
generate loop, now sends the whole lesson script as `context` (unbilled,
untranslated), so terms and tone stay consistent across segments while each
translation stays aligned to its segment for TTS. Scripts over 50,000
characters fall back to a ±4-segment window to stay under DeepL's 128 KiB
request cap. `context_used` stores a short descriptor plus hash, not the
full text. `source_lang` is now always sent (default `EN`) instead of
letting DeepL guess from short segments.

## `segment_translations` is overwritten in place, not deleted and re-inserted
`translateAndStoreSegment` upserts on `(segment_id, target_language)`, so
retranslation no longer hard-deletes first. Stale audio is detected by
comparing the active clip's `sentence_text` to the current
`translated_text` — no new column needed.

## Read endpoints for the frontend console; course status stored locally
The frontend's course list, course page and lesson page need data no
endpoint served: a course list with Released/Draft status, per-language
coverage, a lesson's segments with translation + clip state, and clip
audio. Added `GET /courses`, coverage on `GET /courses/:courseId`,
`GET /lessons/:lessonId/localizations/:language` and
`GET /clips/:clipId/audio`. Status is derived in the backend (one
definition of "audio ready" / "QC failed"), not in the UI. `courses.status`
is a nullable local column set by import — the BI app owns the real value;
a catalog sync replaces the manual path later without a schema change.
Clip audio is proxied through the API rather than via Box shared links so
the browser never touches Box.

## Generate's `boxFolderId` falls back to `BOX_AUDIO_FOLDER_ID`
Callers (the frontend) shouldn't know Box folder ids, and the Box structure
isn't decided yet (audio goes to one interim folder, moved later by file
id). The generate route now uses `BOX_AUDIO_FOLDER_ID` from env when the
body omits `boxFolderId`. It's a folder id, not a secret, so env config is
fine under the secrets rule.

## `force` with `segmentId` regenerates only that segment
Bug fix: `generateLocalizationForLesson` used to supersede every active clip
in the lesson when `force` was set, then regenerate only `segmentId` —
silently discarding the rest of the lesson's audio. `force` and
`verifyBoxFiles` now act only on the clips in scope (the one segment when
`segmentId` is given, else the whole lesson). Found while wiring the
frontend's per-segment "Regenerate audio".

## Optional POST bodies default to `{}` before validation
Bug fix: lesson translations and generate both document their body as
optional, but Fastify validated a missing body against `type: "object"`
and returned 400 before the handler's `request.body ?? {}` ran — so a
frontend POST with no body failed. Fixed with a `preValidation` hook
(`defaultEmptyBody`, `src/routes/default-empty-body.ts`; also on the course
title-translation POST) rather than dropping
`type: "object"` from the schemas, which keeps Swagger accurate and Ajv
strict mode quiet.

## `course_sections` unique index renamed to match the schema
The Azure DB was first migrated from a parallel implementation of the
course-structure change whose index was named
`course_sections_course_section_idx`; `src/db/schema.ts` names it
`course_sections_course_index_idx`. Migration
`0004_rename_course_sections_index` renames it (`IF EXISTS`, so a no-op on
databases built from this branch's 0002) so the DB matches the schema and
future drizzle-kit diffs don't trip over it. Same constraint either way —
naming only.

## Import preview via dry-run; scripts get their own endpoint
Import is a two-step user flow (preview, then confirm), so
`POST /courses/import` and `PUT /courses/:courseId/scripts` take
`?dryRun=true`: the real transaction runs and is rolled back, so the
preview is exactly what a real import would do — no second "diff" code
path to drift. Scripts are often supplied after the structure, and the
import payload is authoritative for membership (a partial course JSON
would remove lessons from the course), so scripts-only uploads are a
separate endpoint that never touches structure.

## Interim exception: the UI parses a course's lessons one at a time
Settled rule: course-scope work runs as a `processing_jobs` job. Exception
until the course-level job runner exists: after an import, the frontend
parses the lessons that have a script but no segments by calling
`POST /lessons/:lessonId/parse` sequentially, showing progress and
per-lesson failures. Acceptable because parse is fast (spaCy + one
transaction) and only ever applied to never-parsed lessons (no data loss).
Re-parsing already-parsed lessons stays an explicit, per-lesson,
confirmed action. Replace with `POST /courses/:courseId/parse` (job) once
the runner is built.

## Catalog text (course/section/lesson titles, descriptions) is translated too
Course name, section titles, lesson names and descriptions are shown to
learners, so they're translated per language into typed tables
(`course_translations`, `section_translations`, `lesson_translations`),
each with an English snapshot for staleness. Course-wide titles are
translated by one sync endpoint (`POST /courses/:courseId/titles/
translations/:lang`) — a few batched DeepL requests rather than a
per-lesson fan-out, so it doesn't need a job. A whole-lesson translate also
refreshes that lesson's name/description. `ITranslationService` gained
`translateMany` (DeepL's multi-text request) for this. Lesson tags are
stored (`lessons.tags`) but not translated.

## One DeepL path for all translation
Every translation — segments, scaffolding, ad-hoc `/translate` — goes
through `translateTexts` (`src/services/translation/translateTexts.ts`),
which resolves the language's glossary and sets an English source.
Callers choose only texts and context; nothing calls
`ITranslationService` or looks up a glossary directly, so no path can
skip the glossary.

## Scaffolding has its own command, and Claude only flags clear errors
Course name, section titles and lesson names/descriptions ("scaffolding")
are translated by one command, `POST /courses/:courseId/scaffolding/
translations/:lang` (`mode: missing | all`), replacing the earlier titles
endpoint. After DeepL, Claude reviews the translations with the course
outline as context. DeepL is the core translator, so the review is biased
toward it: Claude flags only clearly wrong translations (meaning lost,
nonsense in a CAD context, wrong language, garbled), never style, and
never proposes alternatives — DeepL's text is always stored; a flag is
advice for a human. Claude gets no glossary: DeepL already applied it, and
the reviewer's job is catching rare mistranslations from its own
knowledge of the language. A reviewer failure never loses translations
(rows are saved with `review_status` null). Workflow: glossary → translate
scaffolding → review flags → scripts.

## Lesson translation no longer re-translates current titles
Supersedes part of "Catalog text … is translated too": a whole-lesson
translate now fills the lesson's name/description only when missing or
stale (same translate + review pipeline), so titles reviewed after the
scaffolding step aren't silently redone by later script work.
Re-translating current titles is the scaffolding command's `mode: all`.

## Key Vault names mapped in one file; glossary ids synced into the DB
The vault ("AIFastAPI") is shared with other apps and uses its own secret
names (`SP-DEEPL-API-KEY`, `Claude-API-Key`, `ElevenLabsAPIKey`). Code keeps
asking `ISecretsProvider` for logical names; `config/key-vault-names.ts` is
the only place that maps them, and `AzureKeyVaultSecretsProvider` applies
it (unmapped names are looked up as-is). Chosen over renaming vault secrets,
which other apps may read.
Glossary ids also live in the vault (`DeeplGlossary-<Language>`), but the
`glossaries` table stays the runtime source: ids aren't secrets, every
translation snapshots the id it used, and `PUT /languages/:lang/glossary`
keeps working. `npm run glossaries:sync` copies vault → table (es, fr, it;
`DeeplGlossary2` is unused and ignored). Chosen over reading the vault on
every translation (two sources of truth, vault access on the hot path).

## Local real secrets in a git-ignored file
`DummySecretsProvider` also reads `.secrets.local.json` (git-ignored; template
`.secrets.local.example.json`), keyed by logical name; its values win over
the built-in dummy map. Lets local runs use real keys (e.g. the Claude key)
without Key Vault access (a service principal needs tenant-admin rights) and
without committing them. Next step: move the real values still hard-coded
in `dummySecretsProvider.ts` into this file and rotate them.

## Claude reviewer: tool_choice "auto", not forced
First live run: `claude-sonnet-5-5` rejects a forced `tool_choice`
("tool"/"any"). The reviewer now sends `auto`, tells the model to call
`record_verdicts`, and treats a reply without that call as a review failure
(rows saved unreviewed, same as the reviewer being down) — never as
"nothing flagged".

## Hand corrections to scaffolding are kept by "Re-translate all"
Flagged items are fixed by a person in the UI (`PUT
/courses/:courseId/scaffolding/translations/:lang`), not by re-running
DeepL with different settings. A correction is stored as typed, marked
`edited_at`, and its Claude flag cleared. `mode: "all"` skips current
corrections, otherwise every re-run would silently undo human fixes (DeepL's
wording also varies between runs). A correction goes stale — and is
replaced — only when the English changes. One `PUT` for the course's whole
scaffolding (course name, sections, lessons) rather than three per-entity
endpoints: same actor, same screen, and it allows an all-or-nothing batch.
Glossary fixes still belong in the Glossary project; a correction fixes the
course now.

## Glossary ids come from DeepL itself
Supersedes the glossary half of "Key Vault names mapped in one file; glossary
ids synced into the DB". DeepL can't replace a glossary's entries (CSV upload
creates a new glossary), so every glossary update is delete + re-create = a
new id; keeping a copy of that id in Key Vault just adds a second place to
update by hand. `glossaries:sync` / `POST /glossaries/sync` now list the
account's glossaries via the DeepL key and pick the newest ready English→X
glossary per language. The `glossaries` table stays the runtime source (and
each translation still snapshots the id it used). The vault's
`DeeplGlossary-*` secrets are no longer read.

## Course description is scaffolding
`courses.description` is learner-facing, so it's translated with the rest of
the scaffolding (same DeepL path + Claude review, same staleness and
hand-correction rules) and stored on the course's existing
`course_translations` row — one row per course + language, like lessons'
name + description — rather than a separate table. Set through the import
(`description`, optional; omitted = unchanged). A course translated before
the description existed shows as stale until "Translate missing" runs.

## Course translation job; local output folder in place of Box (interim)
Course translation is the first real processing job: one job per course +
language, run in-process, lessons sequentially (each lesson already sends
one DeepL request per segment, so concurrency would only add rate-limit
risk), progress written after every lesson. Mode `missing` makes it
resumable — no separate resume logic. Restart = job marked failed with a
reason; re-run continues. Outputs go through `ILessonOutputStore`; the
interim implementation writes the agreed Box layout to a local folder
(`LOCAL_OUTPUT_ROOT`), so swapping in Box later changes only the store,
not the layout or callers. Scripts are loaded from a folder of
`<lessonId>.txt` files by a CLI (`scripts:load`), not an endpoint — files on
the user's PC aren't reachable from a deployed server anyway.

## Scripts are proofread before they're saved; only mechanical fixes are automatic
Source typos (run-together sentences, missing words) carry into segments,
every translation and the audio, and fixing them after parsing means
re-parsing and re-translating. So `scripts:load --proofread` has Claude
(`IScriptProofreader`) propose minimal fixes first. Whether a fix is applied
is decided in code (`applyScriptCorrections`), not by the model's
confidence: punctuation/spacing, ≤2-letter misspellings, inflections,
merged words, up to two short inserted words, removing doubled words/phrases
— and never a changed number. Everything else is listed for a person in
`_proofread-report.md`. The source files are never edited. The DB keeps the
loaded text in `lessons.script_source_text` so reloading an unchanged file
reuses the stored fixes instead of proofreading again (a model re-run could
produce slightly different fixes and force a re-parse).

## No default voice; per-language voice settings edited in the UI
Supersedes the "fall back to IVoiceSettingsProvider defaults" part of the
voice-settings entries above. A hard-coded fallback voice meant a language
nobody configured was silently voiced by an arbitrary voice — and that row
was then persisted as if chosen. Now `IVoiceSettingsProvider` reads
`language_voice_settings` (`DbVoiceSettingsProvider`) and throws
`VoiceNotConfiguredError` for a missing language; generation answers 400.
Only the non-voice parts (model, stability, similarity…) have starting
defaults (`config/voice-defaults.ts`). The console's Settings page edits one
row per language and previews it via `POST /tts/test`; voice and model
choices come from the account (`GET /tts/options`). `voice_setting_templates`
stays unused (candidate for removal).

## Audio POC: clips saved locally until the Box app is registered (interim)
Box app registration takes time, so audio generation doesn't wait for it.
The generator saves clips through `IClipStore`: `BoxClipStore` (the lesson
generate endpoint, unchanged) or `LocalFolderClipStore`, which writes into
the course folder layout (`<Language> Clips/<lessonId>_<lang>_NNN.mp3`,
numbered like `<Language> Segments.txt`). `tts_clips.local_path` records the
file and `box_file_id` stays null; once Box is set up, the files are
uploaded and `box_file_id` is backfilled from `local_path`. Course-level
audio is a CLI for now (`npm run audio:generate`), not a job endpoint. It
skips lessons that aren't fully translated, so generating audio never calls
DeepL. Each clip also records the `previous_text`/`next_text` it was sent.
Caveat: regenerating a segment overwrites its file, so a superseded row's
`local_path` points at the new audio.

## Formality per language, not a glossary entry
DeepL picks formal/informal "you" per sentence unless told, so Spanish mixed
tú and usted within lessons. A glossary can't fix it (the register lives in
verb endings and possessives, and imperatives have no "you" to map), so the
language's `formality` (language_translation_settings) goes with every DeepL
request through `translateTexts`. Spanish = `more` (usted — matches the Spain
Spanish SOLIDWORKS help; DeepL's `ES` target is already European Spanish).
Each segment_translations row snapshots the formality it was made with; a
row made under a different setting counts as untranslated in the course
translation's "missing" mode, so changing a language's formality is a
resumable re-translation. Scaffolding (titles/descriptions) isn't re-run
automatically.

## Audio to Box: the course folder, same layout as the local folder
Supersedes "Generate's boxFolderId falls back to BOX_AUDIO_FOLDER_ID" and
the flat `<requestId>.mp3` upload. Each course has a top-level Box folder
(`courses.box_folder_id`, set on the course page or in the import JSON).
Clips and Segments.txt go under it exactly as in the local folder:
`<LANG>/<lessonId>/<Language> Segments.txt` and
`<LANG>/<lessonId>/<Language> Clips/<lessonId>_<lang>_NNN.mp3` — one
layout definition (`outputLayout.ts`) serves both. Folders are found or
created (children listed once and cached). A file whose name already exists
is uploaded as a new version (same Box file id, history kept); identical
content (SHA-1) isn't re-uploaded. Box sign-in is the Box app's
client-credentials login (box-client-id/-secret/-enterprise-id), acting as
the app's service account, which must be an Editor on each course folder;
a developer token remains as a testing fallback. Course-level audio is a
processing job (`POST /courses/:id/localizations/:lang/generate`), started
and watched from the course page.

## Language folders are the two-letter code
Output layout (local and Box): `<course>/<LANG>/<lessonId>/<Language> Segments.txt`
and `<LANG>/<lessonId>/<Language> Clips/…` — e.g. `FR/25Sim01_01/French Clips/`.
The language folder is the upper-case code to match the team's Box
convention; file and Clips-folder names keep the full language name.
Defined once in `outputLayout.languageFolder`. Clips generated locally before
this (POC) keep their recorded `local_path` with the old "French/" folder.

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