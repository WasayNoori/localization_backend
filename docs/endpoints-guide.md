# Endpoints Guide

Purpose: Practical reference for every endpoint — what it does, whether it's
sync or async, and what it calls underneath. This is what to check before
wiring up frontend or extending an endpoint.

Per endpoint, cover:
- Method + path
- Sync (returns result directly) or async (returns job ID, must poll)
- Request body shape (link to /requests-response-shapes if a detailed
  example exists there — don't duplicate full payloads here)
- Which service function/interface it calls underneath
- Notable edge cases (e.g. partial failure behavior for fan-out endpoints)

---

## `GET /jobs/:jobId`

Sync — straight read, no polling logic of its own (this endpoint IS what
you poll). Returns the `processing_jobs` row as-is: `status`, `progress`
(`{ succeeded, failed, total }`), timestamps. 404 if `jobId` doesn't exist.
No service/interface underneath — queries `processing_jobs` directly.

**Not yet documented here:** the course-level `POST
/courses/:courseId/parse` and `POST
/courses/:courseId/localizations/:targetLanguage/generate` endpoints that
create the jobs this reads. Those, and the lesson-level parse endpoint they
fan out to, aren't implemented yet — see `docs/decisions.md`.

---

## `POST /lessons/:lessonId/localizations/:targetLanguage/generate`

Sync — lesson-level scope, per the settled sync/async split (only
course-level scope is job-tracked). Thin route; all logic lives in
`generateLocalizationForLesson` (`src/services/generation/
generateLocalizationForLesson.ts`), which this just calls with the relevant
services from the container.

Resumable "find what's missing" resume function, not a one-shot job — see
`docs/pipeline-flow.md` for the full query-loop. Returns a summary:
`{ lessonId, targetLanguage, totalSegments, missingSegments, succeeded, errors }`.
`errors` holds per-segment failures (DeepL/ElevenLabs/DB) that were caught
and skipped, not thrown — a non-empty `errors` array doesn't mean the whole
call failed, just that some segments didn't complete this pass. Re-calling
the same endpoint retries exactly those.

500 `InternalError` only for failures outside the per-segment loop (e.g. the
initial segment query itself failing) — this is broader than the
`502 UpstreamError` convention used by `/translate` and `/tts/synthesize`,
since failures here aren't necessarily upstream-API-shaped.

**Not yet implemented:** the course-level generate endpoint that fans out to
this per-lesson, and this doesn't yet get called by anything else in the
codebase — see `docs/decisions.md`.