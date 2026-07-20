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
