import fp from "fastify-plugin";
import { env } from "../config/env.js";
import { ElevenLabsTtsService } from "../services/tts/ElevenLabsTtsService.js";
import { BoxFileStorageService } from "../services/storage/BoxFileStorageService.js";
import { DbVoiceSettingsProvider } from "../services/voiceSettings/DbVoiceSettingsProvider.js";
import { DeepLTranslationService } from "../services/translation/DeepLTranslationService.js";
import { SpacyNlpService } from "../services/nlp/SpacyNlpService.js";
import { BasicAudioQcService } from "../services/qc/BasicAudioQcService.js";
import { ClaudeTranslationReviewer } from "../services/review/ClaudeTranslationReviewer.js";
import { ClaudeScriptProofreader } from "../services/proofreading/ClaudeScriptProofreader.js";
import { createDbClient } from "../db/client.js";
import { buildSecretsProvider } from "./secrets-provider.js";
import { failInterruptedJobs } from "../services/jobs/courseTranslationJob.js";
import { LocalFolderLessonOutputStore } from "../services/output/LocalFolderLessonOutputStore.js";
import { BoxClipStore } from "../services/output/BoxClipStore.js";
import { MondayBoardReader } from "../services/monday/MondayBoardReader.js";
export const container = fp(async (app) => {
    const secretsProvider = buildSecretsProvider();
    app.decorate("secretsProvider", secretsProvider);
    const [apiKey, databaseUrl] = await Promise.all([
        secretsProvider.getSecret("api-key"),
        secretsProvider.getSecret("database-url"),
    ]);
    app.decorate("secrets", { apiKey, databaseUrl });
    const db = createDbClient(databaseUrl);
    app.decorate("db", db);
    // Course jobs run in-process; any left "running" by a previous process died with it.
    const interrupted = await failInterruptedJobs(db);
    if (interrupted)
        app.log.warn(`Marked ${interrupted} interrupted processing job(s) as failed`);
    const ttsService = new ElevenLabsTtsService(secretsProvider);
    app.decorate("ttsService", ttsService);
    const fileStorageService = new BoxFileStorageService(secretsProvider);
    app.decorate("fileStorageService", fileStorageService);
    app.decorate("clipStore", new BoxClipStore(fileStorageService));
    const voiceSettingsProvider = new DbVoiceSettingsProvider(db);
    app.decorate("voiceSettingsProvider", voiceSettingsProvider);
    const translationService = new DeepLTranslationService(secretsProvider);
    app.decorate("translationService", translationService);
    const nlpService = new SpacyNlpService(env.SPACY_SERVICE_URL);
    app.decorate("nlpService", nlpService);
    const qcService = new BasicAudioQcService();
    app.decorate("qcService", qcService);
    const translationReviewer = new ClaudeTranslationReviewer(secretsProvider, env.ANTHROPIC_REVIEW_MODEL);
    app.decorate("translationReviewer", translationReviewer);
    app.decorate("scriptProofreader", new ClaudeScriptProofreader(secretsProvider, env.ANTHROPIC_REVIEW_MODEL));
    const lessonOutputStore = env.LOCAL_OUTPUT_ROOT ? new LocalFolderLessonOutputStore(env.LOCAL_OUTPUT_ROOT) : null;
    app.decorate("lessonOutputStore", lessonOutputStore);
    app.decorate("mondayBoardReader", new MondayBoardReader(secretsProvider));
});
//# sourceMappingURL=container.js.map