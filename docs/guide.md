# Application Guide

Purpose: A personal reference for navigating this project — translating
unfamiliar TypeScript/Fastify/Node concepts into terms from the .NET/C#
world, plus practical "where do I find/what did I do" notes (Azure hosting
details, deployment locations, gotchas). This is not a design-rationale doc
(see architecture.md) — it's the thing to open when you're lost in the
folder structure or forget where something is deployed.

Format: short sections per concept or component, written as "in C# lingo,
this is X" comparisons where helpful, plus a running notes section for
practical details (Azure resource names, publish profiles, known issues to
watch for).



# Plugins
In C# Lingo, Plusins is a combination of Program.cs service registration plus Middleware for auth services. 

plugins/ is a Fastify-specific concept, and it's doing two distinct jobs in this structure:

1. plugins/container.ts — the composition root
This is where concrete classes get instantiated and wired together, then attached to the Fastify instance so routes can reach them through the interface only.

2. plugins/auth.ts — cross-cutting middleware
Fastify's plugin system is also how you register hooks that run on every (or every matching) request — auth, request logging, CORS, rate limiting. auth.ts registers an onRequest hook that checks the API key header before any route handler runs. Same idea as an ASP.NET Core middleware/filter in the pipeline.