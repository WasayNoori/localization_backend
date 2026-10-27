// src/scripts/copy-lesson-folders.ts
//
// TEMPORARY: copies each lesson's Segments.txt and clips, per language, from
// <course>/<LANG>/<lessonId>/ into <course>/<lessonId>/ in the course's Box
// folder (layout an outside automation needs for now). Server-side Box copies;
// identical files are skipped, changed ones get a new version, so re-running
// only copies what's new. The normal layout, the database and the pipeline
// are untouched.
//
//   npm run box:lesson-folders -- <courseId> [en es it …] [--max-seconds N]
//
// Languages default to every language folder the course has in Box.

import { createDbClient } from "../db/client.js";
import { buildSecretsProvider } from "../plugins/secrets-provider.js";
import { copyToLessonFolders } from "../services/output/copyToLessonFolders.js";
import { BoxFileStorageService } from "../services/storage/BoxFileStorageService.js";
import { parseArgs, runMain } from "./cli-args.js";

runMain(async () => {
  const { positional, value } = parseArgs();
  const [courseId, ...languages] = positional;
  if (!courseId) {
    console.error("Usage: npm run box:lesson-folders -- <courseId> [en es it …] [--max-seconds N]");
    return 1;
  }
  const maxSeconds = Number(value("max-seconds") ?? 0);
  const secrets = buildSecretsProvider();
  const db = createDbClient(await secrets.getSecret("database-url"));
  const started = Date.now();
  const r = await copyToLessonFolders({ db, fileStorageService: new BoxFileStorageService(secrets) }, courseId, {
    languages: languages.length ? languages : undefined,
    deadline: maxSeconds > 0 ? started + maxSeconds * 1000 : undefined,
    onLesson: (language, lessonId, files) => console.log(`${language.toUpperCase()} ${lessonId}: ${files} file(s)`),
  });
  console.log(
    `\n${r.done ? "Done" : "Stopped at --max-seconds — run again to continue"} in ${Math.round((Date.now() - started) / 1000)} s: ` +
      `${r.counts.copied} copied, ${r.counts.updated} updated, ${r.counts.unchanged} already there, ${r.foldersCreated} lesson folder(s) created.`
  );
  for (const [language, ids] of Object.entries(r.nothingToCopy)) {
    if (ids.length) console.log(`${language.toUpperCase()}: nothing to copy for ${ids.length} lesson(s): ${ids.join(", ")}`);
  }
  for (const e of r.errors.slice(0, 20)) console.log(`ERROR ${e.language.toUpperCase()} ${e.lessonId} ${e.file ?? ""}: ${e.error}`);
  if (r.errors.length > 20) console.log(`… and ${r.errors.length - 20} more error(s) — run again to retry them`);
  return r.errors.length ? 2 : 0;
});
