# Project CLAUDE.md — Localization Pipeline

Project-specific conventions for Claude Code. For cross-project developer
identity/philosophy, see global `~/.claude/CLAUDE.md`. This file covers only
what's specific to this repo.

## Architecture principles

- **Interface-first, deep modules.** All concrete classes implement
  interfaces; light interfaces, heavy implementations underneath. Wire
  concrete implementations exclusively in `plugins/container.ts` (the
  composition root) — never instantiate concrete classes elsewhere.
- **Secrets never in `process.env`/envSchema.** All secrets go through
  `ISecretsProvider` (`DummySecretsProvider` locally,
  `AzureKeyVaultSecretsProvider` in production).
- **Build the real thing incrementally.** No throwaway stubs, no placeholder
  names that will need renaming later. If something is genuinely interim
  (e.g. `lessons`/`courses` tables standing in for the not-yet-built LCMS),
  build it as a real, load-bearing piece — not a mock — and document why in
  `docs/decisions.md`.
- **Naming:** kebab-case, lowercase file names (`tts.route.ts`,
  `health.route.ts`), with matching camelCase export function names.
- **Endpoint separation rule:** split endpoints when a different actor or
  genuinely independent action is involved — not merely because two steps
  are conceptually distinct. Same actor + sequential steps = one endpoint
  internally orchestrating multiple stages, not several endpoints.
- **Fan-out over duplication:** course-level endpoints call the *same*
  underlying lesson-level service functions in a loop — never reimplement
  per-lesson logic at the course level.
- **Sync vs async split (settled):** lesson-level parse/generate endpoints
  stay synchronous (fast, single-item). Course-level endpoints
  (multi-lesson fan-out) are async — return a job ID via `processing_jobs`,
  frontend polls. Do not make this uniform across both levels without an
  explicit decision logged in `docs/decisions.md`.
- **Pipeline stages are decoupled:** parsing (spaCy + segment commit) and
  generation (translation + audio) are separate operations, not one combined
  flow. A segment can exist with no translation; audio can be generated with
  or without translation.
- **spaCy service stays scoped strictly to NLP.** No DB access, no Box
  access, no secrets beyond what the model itself needs. All persistence and
  orchestration lives in the main TS/Fastify app.

## Stack

TypeScript/Fastify (main API), Python/FastAPI (spaCy microservice), Drizzle
ORM, PostgreSQL (Azure), ElevenLabs (TTS), DeepL (translation), Box (file
storage), Azure Key Vault (secrets), LangChain JS/TS (orchestration).

## Documentation maintenance (do this proactively, not on request)

After completing any change, update the relevant file(s) as part of the same
task:

- **New/changed endpoint** → `docs/endpoints-guide.md`
- **New/changed table/column** → `docs/rationale/schema-guide.md`
- **A design decision was made or changed** (chose X over Y, and why) →
  append to `docs/decisions.md`. Never edit/delete prior entries — append
  and reference if superseded.
- **New file/folder/concept introduced that isn't obvious from context**
  (especially TS/Fastify idioms unfamiliar coming from C#/.NET) → add a
  short section to `docs/guide.md`
- **Step-by-step request flow changed** (new stage, new async/job boundary)
  → update `docs/pipeline-flow.md`
- **A new "where do I go to change X" pattern emerged** → add an entry to
  `docs/How-to-modify-guide.md`

Keep doc updates concise, matching each file's existing tone. Don't
restructure or rewrite unrelated sections while doing so.

## Communication style

- Design/architecture decisions happen in chat first; Claude Code handles
  implementation against the real repo.
- Tight, high-signal responses — concise summaries with clear rationale,
  not expansive explanations.
- C#/.NET mental models are the default frame for explaining TS/Fastify
  concepts (e.g. `container.ts` ↔ composition root, Fastify plugins ↔
  ASP.NET Core middleware).