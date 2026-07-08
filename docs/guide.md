# Plugins
In C# Lingo, Plusins is a combination of Program.cs service registration plus Middleware for auth services. 

plugins/ is a Fastify-specific concept, and it's doing two distinct jobs in this structure:

1. plugins/container.ts — the composition root
This is where concrete classes get instantiated and wired together, then attached to the Fastify instance so routes can reach them through the interface only.

2. plugins/auth.ts — cross-cutting middleware
Fastify's plugin system is also how you register hooks that run on every (or every matching) request — auth, request logging, CORS, rate limiting. auth.ts registers an onRequest hook that checks the API key header before any route handler runs. Same idea as an ASP.NET Core middleware/filter in the pipeline.