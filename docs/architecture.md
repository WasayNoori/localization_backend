# Architecture

Purpose: The 30,000-ft view of the system. Answers "what are the pieces and
why do they exist," not "how does a request flow" (see pipeline-flow.md) or
"why did we decide X" (see decisions.md).

Should cover:
- Main API (TS/Fastify) vs spaCy microservice — what each owns and why they're split
- Interface-first pattern: where interfaces live, where implementations live,
  container.ts as composition root
- External dependencies: DeepL, ElevenLabs, Box, Azure Key Vault — one line
  each on what they're used for
- LCMS relationship: current interim state (lessons/courses tables owned by
  us) vs future state (LCMS-sourced)
- A simple diagram (ASCII is fine) showing main API ↔ spaCy ↔ DB ↔ external services

This file changes rarely — only when a structural piece is added or removed.

---

## 1. System components

**Main API** (TypeScript/Fastify) owns all orchestration: routing, business
logic, persistence, and every call to an external service (DeepL,
ElevenLabs, Box, and the spaCy microservice). This is the only component
the frontend ever talks to.

**spaCy microservice** (`spacy-nlp-service`, Python/FastAPI) is a
standalone service scoped strictly to NLP processing: sentence boundary
detection and "etc."-style abbreviation handling, plus grammar correction
behind an abstract interface (currently a no-op). It has no database
access, no Box access, and no secrets beyond what the model itself needs.
It does not decide anything about persistence, transactions, or pipeline
sequencing — it is a pure function-as-a-service: text in, segmented
sentences out over HTTP. "Microservice" here means single-purpose service,
not distributed-systems architecture — it deploys the same way the main API
does (same Node/Azure App Service hosting pattern, just a separate
deployable unit). The main API is the only caller of this service; the
frontend never talks to it directly, and it never talks to Postgres, Box,
DeepL, or ElevenLabs directly.

**PostgreSQL (Azure)** is the single source of truth for all pipeline
state. Accessed only from the main API, via Drizzle ORM.

**Box** is external file storage. Source scripts and generated audio clips
live here; the database stores Box file IDs, never file contents.

**Azure Key Vault** backs `ISecretsProvider` in production; no secrets ever
live in `process.env` or `envSchema`.

---

## 2. Interface-first design

Every concrete class implements an interface — light interfaces
(`ISecretsProvider`, `ITranslationService`, `ITextToSpeechService`,
`IFileStorageService`, `IVoiceSettingsProvider`, `INlpService`,
`IAudioQcService`) with heavier implementations underneath. Routes and
other services depend on the interface only, never a concrete class
directly.

All wiring happens exclusively in `plugins/container.ts` — the composition
root. This is the only place a concrete class is ever instantiated;
everything else reaches its dependencies through the Fastify instance
decorations set up there.

In C#/.NET terms: `container.ts` is the equivalent of ASP.NET Core's DI
container / composition root (`Program.cs` service registration).
`plugins/auth.ts` is the equivalent of ASP.NET Core middleware — it
registers an `onRequest` hook, the same pipeline position as a
middleware/filter.

---

## 3. External dependencies

**DeepL** translates segment text into target languages.

**ElevenLabs** generates text-to-speech audio from either English or
translated segment text.

**Box** stores source scripts (read) and generated audio (write).

**Azure Key Vault** handles secrets management, abstracted behind
`ISecretsProvider` so the rest of the codebase never knows whether it's
talking to Key Vault or a local dummy provider.

---

## 4. LCMS relationship (current vs. future state)

Today, `courses` and `lessons` are real, interim tables owned by this
pipeline (full schema in `rationale/schema-guide.md`) — not placeholders.
They're load-bearing and populated manually/internally.

Once the separate LCMS system ships, these tables become local
shadow/reference tables: `id` values will originate from LCMS (synced or
looked up), but the tables themselves remain. `box_file_id` and
`parsed_at` stay pipeline-owned regardless of LCMS, since they're facts
about this pipeline's processing of a lesson, not about the course catalog
itself.

Everything downstream (`lesson_segments`, `segment_translations`,
`lesson_localizations`, `tts_clips`) references `lesson_id` as a bare
string, with no FK to `lessons` yet — deliberate, to avoid coupling
pipeline tables to a table whose backing source will change.

Day-to-day course/lesson content work currently happens in Monday.com;
this pipeline's `courses`/`lessons` tables aren't meant to replace that —
they exist only to give this system something to key processing off of
until LCMS exists as the real conduit.

---

## 5. Diagram

```
Frontend
   │
   ▼
Main API (TS/Fastify)
   │
   ├──► spaCy microservice (Python/FastAPI) — sentence segmentation
   ├──► DeepL — translation
   ├──► ElevenLabs — text-to-speech
   ├──► PostgreSQL (Azure) — all pipeline state
   └──► Box — source scripts (read), audio clips (write)

Secrets: Main API ──► Azure Key Vault (via ISecretsProvider)
```