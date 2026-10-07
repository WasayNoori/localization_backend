# How to Modify Guide

Purpose: "Where do I go to change X" — a map from common change requests to
the exact file/folder to start in. Not rationale (see decisions.md), not
what-it-does (see endpoints-guide.md) — purely where to make a change.

Format:
## To <change something>
Start in: <file/folder path>
Also touch: <other files affected, if any>

Example entries to seed:
## To add a new endpoint
Start in: routes/ — add route file, register in routes/index.ts, wire any
new service in container.ts

## To change how a course/section/lesson structure is loaded
Start in: src/services/catalog/importCourseStructure.ts
Also touch: src/routes/courses.route.ts (request schema), src/db/schema.ts
(courses, course_sections, course_lessons, lessons)

## To change what counts as "translated" / "audio ready" in the UI
Start in: src/services/catalog/getLessonLocalization.ts (per-segment status)
Also touch: src/services/catalog/getLocalizationCoverage.ts (counts)

## To change how scaffolding (titles/descriptions) is translated
Start in: src/services/translation/translateScaffolding.ts
Also touch: src/services/translation/translateTexts.ts (the single DeepL path)

## To change what Claude flags in scaffolding translations
Start in: src/services/review/ClaudeTranslationReviewer.ts (`SYSTEM_PROMPT`)
Model: `ANTHROPIC_REVIEW_MODEL` env var; key: `anthropic-api-key` secret

## To add or rename a Key Vault secret
`src/config/key-vault-names.ts`: logical name → vault name. Locally, also
add any new logical name to `DummySecretsProvider` / `.secrets.local.json`.

## After uploading a DeepL glossary (or for a new language)
`npm run glossaries:sync -- --dry-run`, then without `--dry-run` (or
`POST /glossaries/sync`). Picks the newest English→X glossary per language
from DeepL — nothing to configure. Rule lives in
`src/services/glossaries/syncGlossariesFromProvider.ts`.

## To use a real key locally (dummy mode)
Copy `.secrets.local.example.json` to `.secrets.local.json` (git-ignored) and
add `"<logical name>": "<value>"` — e.g. `anthropic-api-key`. Restart the
server; the file is read once at startup.

## To change how hand corrections to scaffolding work
`src/services/translation/correctScaffolding.ts` (validation + write) and
the `redo` rule in `translateScaffolding.ts` (which rows `mode: "all"`
re-translates). Column: `edited_at` on the three `*_translations` tables.

## To change the output folder layout / file names
`src/services/output/outputLayout.ts` (folder + file names, Segments.txt
format). Root: `LOCAL_OUTPUT_ROOT`. Language folder names:
`src/config/languages.ts`. Box later = a new `ILessonOutputStore`
implementation wired in `container.ts`.

## To change how a course translation job runs
Fan-out + resume rule: `src/services/translation/translateCourseLessons.ts`.
Job row, conflict check, restart recovery:
`src/services/jobs/courseTranslationJob.ts`.

## To change what the script proofreader fixes
Prompt: `src/services/proofreading/ClaudeScriptProofreader.ts`. What gets
applied automatically vs listed for review: `whyNotMechanical` in
`src/services/proofreading/applyScriptCorrections.ts`.

## To change where generated clips are saved
`IClipStore` — `BoxClipStore` (the generate endpoint, wired in `plugins/container.ts`)
or `LocalFolderClipStore` (`npm run audio:generate`, the local POC). File names
come from `services/output/outputLayout.ts` (`clipFilePath`).

## To change formal/informal "you" for a language
`PUT /languages/:lang/translation-settings` (`language_translation_settings.formality`),
applied in `services/translation/translateTexts.ts`. Then re-run
`course:translate` for that language — rows with the old formality are stale.

## To change voice settings per language
In the console: Settings. API: `PUT /languages/:lang/voice-settings`.
Starting values for new languages: `src/config/voice-defaults.ts`. Allowed
ranges: `language-voice-settings.route.ts`.

## To change where parse reads the script from
Start in: src/services/parsing/parseLessonSegments.ts (`loadScriptText`)

## To change what DeepL receives as context
Start in: src/services/translation/buildLessonContext.ts (size cap, window)
Also touch: translateAndStoreSegment.ts (what's stored in context_used)

## To change how sentences are split
Start in: spacy-nlp-service/nlp/rules.py

### API Routes
the routes are added to /Routes/ folder. For example tts-route.ts.  They are all registered in /Routes/index.ts. THis means that in app.ts I am only importing from Index.ts and don't have to grow it each time a route is added. 

### Key Vault Changes
When going live: set SECRETS_PROVIDER=azure-key-vault and KEY_VAULT_URL=https://<vault>.vault.azure.net/ â no code changes needed, DefaultAzureCredential picks up managed identity in Azure.

### Authorizations
auth.ts blocks all except the ones that are explicitly exempt such as health.

Current auth is a single shared `x-api-key` (static string compare against `app.secrets.apiKey`). This is a placeholder, not the long-term design.

**Decision (not yet implemented):** move to Entra ID (Azure AD) App Registrations using the client-credentials flow, for both expected consumer types:
- Service-to-service (main usage) — another backend calling this API directly.
- Team-built consumers (custom internal apps, Monday.com apps) — not a fixed/known set upfront, grows over time.

Why this over alternatives:
- A static shared key has no per-consumer identity, no audit trail, and rotating it breaks every consumer at once.
- A hand-rolled signed JWT fixes expiry/claims but still requires building and securing our own signing secret + token-issuing endpoint, and doesn't solve identity for browser-exposed tokens.
- Entra ID App Registrations give each consumer its own client_id/secret, independently revocable, with Microsoft handling token issuance/signing/JWKS. New consumers (a new custom app, a new Monday integration) just get a new App Registration — no changes to existing consumers.
- Team-specific defaults (glossary, voice ID, etc.) can be keyed off the caller's `appid`/`azp` claim in the validated token, so consumers just call the endpoint and get results without passing config each time.

Implementation deferred until this is actually needed.
