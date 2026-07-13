import fp from "fastify-plugin";
import type { FastifyInstance } from "fastify";
import { env } from "../config/env.js";
import type { ISecretsProvider } from "../interfaces/index.js";
import { DummySecretsProvider } from "../services/secrets/dummySecretsProvider.js";
import { AzureKeyVaultSecretsProvider } from "../services/secrets/azureKeyVaultSecretsProvider.js";
import type { ITextToSpeechService } from "../interfaces/ITextToSpeechService.js";
import { ElevenLabsTtsService } from "../services/tts/ElevenLabsTtsService.js";
import type { IFileStorageService } from "../interfaces/IFileStorageService.js";
import { BoxFileStorageService } from "../services/storage/BoxFileStorageService.js";
import type { IVoiceSettingsProvider } from "../interfaces/IvoiceSettingsProvider.js";
import { HardcodedVoiceSettingsProvider } from "../services/voiceSettings/HardcodedVoiceSettingsProvider.js";
import type { ITranslationService } from "../interfaces/ITranslationService.js";
import { DeepLTranslationService } from "../services/translation/DeepLTranslationService.js";

export interface Secrets {
  apiKey: string;
  databaseUrl: string;
}

declare module "fastify" {
  interface FastifyInstance {
    secretsProvider: ISecretsProvider;
    secrets: Secrets;
    ttsService: ITextToSpeechService;
    fileStorageService: IFileStorageService;
    voiceSettingsProvider: IVoiceSettingsProvider;
    translationService: ITranslationService;
    // decorate with concrete service implementations as they're built,
    // e.g. nlpService: INlpService, ...
  }
}

function buildSecretsProvider(): ISecretsProvider {
  if (env.SECRETS_PROVIDER === "azure-key-vault") {
    if (!env.KEY_VAULT_URL) {
      throw new Error("KEY_VAULT_URL is required when SECRETS_PROVIDER=azure-key-vault");
    }
    return new AzureKeyVaultSecretsProvider(env.KEY_VAULT_URL);
  }
  return new DummySecretsProvider();
}

export const container = fp(async (app: FastifyInstance) => {
  const secretsProvider = buildSecretsProvider();
  app.decorate("secretsProvider", secretsProvider);

  const [apiKey, databaseUrl] = await Promise.all([
    secretsProvider.getSecret("API_KEY"),
    secretsProvider.getSecret("DATABASE_URL"),
  ]);
  app.decorate("secrets", { apiKey, databaseUrl } satisfies Secrets);

  const ttsService = new ElevenLabsTtsService(secretsProvider);
  app.decorate("ttsService", ttsService);

  const fileStorageService = new BoxFileStorageService();
  app.decorate("fileStorageService", fileStorageService);

  const voiceSettingsProvider = new HardcodedVoiceSettingsProvider();
  app.decorate("voiceSettingsProvider", voiceSettingsProvider);

  const translationService = new DeepLTranslationService(secretsProvider);
  app.decorate("translationService", translationService);
});
