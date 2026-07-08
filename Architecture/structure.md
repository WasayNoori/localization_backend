src/
  server.ts            <- ~10 lines: create app, listen. Nothing else.
  app.ts               <- builds the Fastify instance, registers plugins/routes
  config/
    env.ts             <- typed, validated env (zod schema, fails fast on boot)
  plugins/
    container.ts        <- composition root: builds every service, decorates Fastify
    auth.ts              <- API key check (onRequest hook)
  interfaces/           <- the contracts (ISecretsProvider, INlpService,
                            ITranslationService, ITextToSpeechService,
                            IAudioQcService, IFileStorageService)
  services/              <- the "bulk of the code" - one implementation per interface
    secrets/  nlp/  translation/  tts/  storage/
  db/                    <- drizzle schema + client (behind an interface too)
  routes/                <- thin controllers: parse request -> call interface -> respond
  types/                 <- shared DTOs