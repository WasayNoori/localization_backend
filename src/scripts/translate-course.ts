// src/scripts/translate-course.ts
//
// Same work as POST /courses/:courseId/translations/:lang, run from the
// command line (no server needed), languages in parallel:
//
//   npm run course:translate -- 25Sim fr es it [--all] [--max-seconds 900]
//
// Default mode "missing" only translates untranslated segments, so it can be
// stopped (--max-seconds) and run again to continue.

import { env } from "../config/env.js";
import { createDbClient } from "../db/client.js";
import { buildSecretsProvider } from "../plugins/secrets-provider.js";
import { ClaudeTranslationReviewer } from "../services/review/ClaudeTranslationReviewer.js";
import { DeepLTranslationService } from "../services/translation/DeepLTranslationService.js";
import { translateCourseLessons } from "../services/translation/translateCourseLessons.js";
import { parseArgs, runMain } from "./cli-args.js";

runMain(async () => {
  const { positional, flag, outOfTime } = parseArgs();
  const [courseId, ...languages] = positional;
  if (!courseId || !languages.length) {
    console.error("Usage: npm run course:translate -- <courseId> <lang> [lang…] [--all] [--max-seconds N]");
    return 1;
  }
  const secrets = buildSecretsProvider();
  const deps = {
    db: createDbClient(await secrets.getSecret("database-url")),
    translationService: new DeepLTranslationService(secrets),
    translationReviewer: new ClaudeTranslationReviewer(secrets, env.ANTHROPIC_REVIEW_MODEL),
  };
  const mode = flag("all") ? "all" : "missing";
  const results = await Promise.all(
    languages.map((lang) =>
      translateCourseLessons(deps, courseId, lang, {
        mode,
        shouldStop: outOfTime,
        onProgress: (p, lessonId) => {
          const done = p.succeeded.length + p.failed.length + p.skipped.length;
          const last = p.failed.at(-1)?.lessonId === lessonId ? `FAILED ${p.failed.at(-1)!.error}` : p.skipped.at(-1)?.lessonId === lessonId ? `skipped (${p.skipped.at(-1)!.reason})` : "ok";
          console.log(`[${lang}] ${String(done).padStart(3)}/${p.total} ${lessonId} ${last}`);
        },
      }).then((r) => ({ lang, ...r }))
    )
  );
  for (const r of results) {
    const skippedTranslated = r.skipped.filter((s) => s.reason === "already translated").length;
    console.log(
      `${r.lang}: ${r.succeeded.length} translated · ${r.failed.length} failed · ${skippedTranslated} already done · ` +
        `${r.skipped.length - skippedTranslated} not parsed${r.stopped ? " · STOPPED (time limit) — run again to continue" : ""}`
    );
    for (const f of r.failed) console.log(`  ${f.lessonId}: ${f.error}`);
  }
  return results.some((r) => r.failed.length) ? 1 : 0;
});
