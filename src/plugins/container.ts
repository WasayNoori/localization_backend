import fp from "fastify-plugin";
import type { FastifyInstance } from "fastify";
import { env } from "../config/env.js";
import type { ISecretsProvider } from "../interfaces/index.js";
import type { ITextToSpeechService } from "../interfaces/ITextToSpeechService.js";
import { ElevenLabsTtsService } from "../services/tts/ElevenLabsTtsService.js";
import type { IFileStorageService } from "../interfaces/IFileStorageService.js";
import { BoxFileStorageService } from "../services/storage/BoxFileStorageService.js";
import type { IVoiceSettingsProvider } from "../interfaces/IvoiceSettingsProvider.js";
import { HardcodedVoiceSettingsProvider } from "../services/voiceSettings/HardcodedVoiceSettingsProvider.js";
import type { ITranslationService } from "../interfaces/ITranslationService.js";
import { DeepLTranslationService } from "../services/translation/DeepLTranslationService.js";
import type { INlpService } from "../interfaces/INlpService.js";
import { SpacyNlpService } from "../services/nlp/SpacyNlpService.js";
import type { IAudioQcService } from "../interfaces/IAudioQcService.js";
import { BasicAudioQcService } from "../services/qc/BasicAudioQcService.js";
import type { ITranslationReviewer } from "../interfaces/ITranslationReviewer.js";
import { ClaudeTranslationReviewer } from "../services/review/ClaudeTranslationReviewer.js";
import { createDbClient, type Database } from "../db/client.js";
import { buildSecretsProvider } from "./secrets-provider.js";
import { failInterruptedJobs } from "../services/jobs/courseTranslationJob.js";
import type { ILessonOutputStore } from "../interfaces/ILessonOutputStore.js";
import { LocalFolderLessonOutputStore } from "../services/output/LocalFolderLessonOutputStore.js";

export interface Secrets {
  apiKey: string;
  databaseUrl: string;
}

declare module "fastify" {
  interface FastifyInstance {
    secretsProvider: ISecretsProvider;
    secrets: Secrets;
    db: Database;
    ttsService: ITextToSpeechService;
    fileStorageService: IFileStorageService;
    voiceSettingsProvider: IVoiceSettingsProvider;
    translationService: ITranslationService;
    nlpService: INlpService;
    qcService: IAudioQcService;
    translationReviewer: ITranslationReviewer;
    /** Null when LOCAL_OUTPUT_ROOT isn't set. */
    lessonOutputStore: ILessonOutputStore | null;
    // decorate with concrete service implementations as they're built, ...
  }
}

export const container = fp(async (app: FastifyInstance) => {
  const secretsProvider = buildSecretsProvider();
  app.decorate("secretsProvider", secretsProvider);

  const [apiKey, databaseUrl] = await Promise.all([
    secretsProvider.getSecret("api-key"),
    secretsProvider.getSecret("database-url"),
  ]);
  app.decorate("secrets", { apiKey, databaseUrl } satisfies Secrets);

  const db = createDbClient(databaseUrl);
  app.decorate("db", db);

  // Course jobs run in-process; any left "running" by a previous process died with it.
  const interrupted = await failInterruptedJobs(db);
  if (interrupted) app.log.warn(`Marked ${interrupted} interrupted processing job(s) as failed`);

  const ttsService = new ElevenLabsTtsService(secretsProvider);
  app.decorate("ttsService", ttsService);

  const fileStorageService = new BoxFileStorageService(secretsProvider);
  app.decorate("fileStorageService", fileStorageService);

  const voiceSettingsProvider = new HardcodedVoiceSettingsProvider();
  app.decorate("voiceSettingsProvider", voiceSettingsProvider);

  const translationService = new DeepLTranslationService(secretsProvider);
  app.decorate("translationService", translationService);

  const nlpService = new SpacyNlpService(env.SPACY_SERVICE_URL);
  app.decorate("nlpService", nlpService);

  const qcService = new BasicAudioQcService();
  app.decorate("qcService", qcService);

  const translationReviewer = new ClaudeTranslationReviewer(secretsProvider, env.ANTHROPIC_REVIEW_MODEL);
  app.decorate("translationReviewer", translationReviewer);

  const lessonOutputStore = env.LOCAL_OUTPUT_ROOT ? new LocalFolderLessonOutputStore(env.LOCAL_OUTPUT_ROOT) : null;
  app.decorate("lessonOutputStore", lessonOutputStore);
});
