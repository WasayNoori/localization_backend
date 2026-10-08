// src/scripts/generate-audio.ts
//
// POC (until the Box app is registered): generates missing audio for a
// course and saves the clips locally, in the course folder layout:
// <LOCAL_OUTPUT_ROOT>/<courseFolder>/<LANG>/<lessonId>/<Language> Clips/<lessonId>_<lang>_NNN.mp3
// tts_clips.local_path records each file; box_file_id is backfilled later.
//
//   npm run audio:generate -- 25Sim "SOLIDWORKS Simulation\SOLIDWORKS Simulation" fr es it
//     [--lessons 25Sim01_01,25Sim01_02] [--estimate] [--max-seconds N]
//
// --estimate counts missing clips and characters without calling ElevenLabs.
// Only fills what's missing, so it can be stopped and run again to continue.
// Languages run in parallel; lessons and segments one at a time.

import { createDbClient } from "../db/client.js";
import { env } from "../config/env.js";
import { buildSecretsProvider } from "../plugins/secrets-provider.js";
import { generateCourseAudio } from "../services/generation/generateCourseAudio.js";
import { LocalFolderClipStore } from "../services/output/LocalFolderClipStore.js";
import { LocalFolderLessonOutputStore } from "../services/output/LocalFolderLessonOutputStore.js";
import { courseFolderParts } from "../services/output/outputLayout.js";
import { BasicAudioQcService } from "../services/qc/BasicAudioQcService.js";
import { DeepLTranslationService } from "../services/translation/DeepLTranslationService.js";
import { ElevenLabsTtsService } from "../services/tts/ElevenLabsTtsService.js";
import { DbVoiceSettingsProvider } from "../services/voiceSettings/DbVoiceSettingsProvider.js";
import { parseArgs, runMain } from "./cli-args.js";

runMain(async () => {
  const { positional, flag, value, outOfTime } = parseArgs();
  const [courseId, courseFolder, ...languages] = positional;
  if (!courseId || !courseFolder || !languages.length) {
    console.error('Usage: npm run audio:generate -- <courseId> "<courseFolder>" <lang> [lang…] [--lessons a,b] [--estimate] [--max-seconds N]');
    return 1;
  }
  if (!env.LOCAL_OUTPUT_ROOT) {
    console.error("Set LOCAL_OUTPUT_ROOT (e.g. C:\\Translations) in .env");
    return 1;
  }
  courseFolderParts(courseFolder);
  const estimateOnly = flag("estimate");
  const lessonIds = value("lessons")?.split(",").map((s) => s.trim()).filter(Boolean);

  const secrets = buildSecretsProvider();
  const db = createDbClient(await secrets.getSecret("database-url"));
  const deps = {
    db,
    translationService: new DeepLTranslationService(secrets),
    ttsService: new ElevenLabsTtsService(secrets),
    qcService: new BasicAudioQcService(),
    voiceSettingsProvider: new DbVoiceSettingsProvider(db),
    clipStore: new LocalFolderClipStore(new LocalFolderLessonOutputStore(env.LOCAL_OUTPUT_ROOT)),
    boxFolderId: null,
    courseFolder,
  };

  if (!estimateOnly) {
    // Fail up front for a language without a voice, before any lesson starts.
    for (const lang of languages) await deps.voiceSettingsProvider.getSettings(lang);
  }

  const results = await Promise.all(
    languages.map((language) =>
      generateCourseAudio(deps, courseId, language, {
        lessonIds,
        estimateOnly,
        shouldStop: outOfTime,
        onLesson: (l, done, total) => {
          if (estimateOnly) return;
          const status = l.skipped ?? `${l.generated}/${l.missing} clips${l.errors.length ? ` · ${l.errors.length} FAILED` : ""}`;
          console.log(`[${language}] ${String(done).padStart(3)}/${total} ${l.lessonId} ${status}`);
        },
      })
    )
  );

  let failed = 0;
  for (const r of results) {
    const sum = (f: (l: (typeof r.lessons)[number]) => number) => r.lessons.reduce((n, l) => n + f(l), 0);
    const notTranslated = r.lessons.filter((l) => l.skipped?.includes("not translated")).length;
    const complete = r.lessons.filter((l) => l.skipped === "audio complete").length;
    if (estimateOnly) {
      console.log(
        `${r.language}: ${sum((l) => l.missing)} clips missing · ${sum((l) => l.characters).toLocaleString()} characters` +
          ` · ${complete} lessons complete · ${notTranslated} not translated`
      );
      continue;
    }
    const errors = r.lessons.flatMap((l) => l.errors.map((e) => ({ lessonId: l.lessonId, ...e })));
    failed += errors.length;
    console.log(
      `${r.language}: ${sum((l) => l.generated)} clips · ${sum((l) => l.characters).toLocaleString()} characters · ${errors.length} failed` +
        ` · ${complete} lessons already complete · ${notTranslated} not translated${r.stopped ? " · STOPPED (time limit) — run again to continue" : ""}`
    );
    for (const e of errors) console.log(`  ${e.lessonId} ${e.segmentId}: ${e.error}`);
  }
  return failed ? 1 : 0;
});
