// src/scripts/write-segments.ts
//
// Same as POST /courses/:courseId/outputs/segments: writes
// <LOCAL_OUTPUT_ROOT>/<courseFolder>/<LANG>/<lessonId>/<Language> Segments.txt
//
//   npm run outputs:segments -- 25Sim "SOLIDWORKS Simulation\SOLIDWORKS Simulation" en fr es it

import { env } from "../config/env.js";
import { createDbClient } from "../db/client.js";
import { buildSecretsProvider } from "../plugins/secrets-provider.js";
import { LocalFolderLessonOutputStore } from "../services/output/LocalFolderLessonOutputStore.js";
import { writeCourseSegmentsFiles } from "../services/output/writeCourseSegmentsFiles.js";
import { parseArgs, runMain } from "./cli-args.js";

runMain(async () => {
  const { positional } = parseArgs();
  const [courseId, courseFolder, ...languages] = positional;
  if (!courseId || !courseFolder || !languages.length) {
    console.error('Usage: npm run outputs:segments -- <courseId> "<courseFolder>" <lang> [lang…]');
    return 1;
  }
  if (!env.LOCAL_OUTPUT_ROOT) {
    console.error("Set LOCAL_OUTPUT_ROOT (e.g. C:\\Translations) in .env");
    return 1;
  }
  const db = createDbClient(await buildSecretsProvider().getSecret("database-url"));
  const r = await writeCourseSegmentsFiles({ db, outputStore: new LocalFolderLessonOutputStore(env.LOCAL_OUTPUT_ROOT) }, courseId, {
    languages,
    courseFolder,
  });
  const count = (lang: string) => r.written.filter((w) => w.language === lang).length;
  console.log(`Wrote ${r.written.length} files under ${env.LOCAL_OUTPUT_ROOT} / ${r.courseFolder}`);
  for (const lang of languages) console.log(`  ${lang}: ${count(lang)} lessons`);
  const reasons = new Map<string, number>();
  for (const s of r.skipped) reasons.set(`${s.language}: ${s.reason.replace(/^\d+ of \d+ /, "some ")}`, (reasons.get(`${s.language}: ${s.reason.replace(/^\d+ of \d+ /, "some ")}`) ?? 0) + 1);
  for (const [reason, n] of reasons) console.log(`  skipped ${n} × ${reason}`);
  return 0;
});
