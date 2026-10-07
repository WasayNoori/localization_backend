// src/scripts/load-scripts.ts
//
// Loads a course's English scripts from a folder of .txt files named by
// lesson id (25Sim01_01.txt), then optionally parses them into segments:
//
//   npm run scripts:load -- 25Sim "C:\path\to\scripts" --dry-run
//   npm run scripts:load -- 25Sim "C:\path\to\scripts" --parse [--max-seconds 600]
//
// Files for lessons not in the course are reported and ignored. --parse
// parses lessons never parsed, or whose script changed since parsing
// (re-parsing deletes that lesson's translations and audio). Re-run to
// continue after --max-seconds stops it.

import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { inArray } from "drizzle-orm";
import { env } from "../config/env.js";
import { createDbClient } from "../db/client.js";
import { lessons } from "../db/schema.js";
import { buildSecretsProvider } from "../plugins/secrets-provider.js";
import { updateCourseScripts } from "../services/catalog/updateCourseScripts.js";
import { SpacyNlpService } from "../services/nlp/SpacyNlpService.js";
import { parseLessonSegments } from "../services/parsing/parseLessonSegments.js";
import { courseLessonOrder } from "../services/translation/translateCourseLessons.js";
import { parseArgs, runMain } from "./cli-args.js";

runMain(async () => {
  const { positional, flag, outOfTime } = parseArgs();
  const [courseId, folder] = positional;
  if (!courseId || !folder) {
    console.error('Usage: npm run scripts:load -- <courseId> <folder> [--dry-run] [--parse] [--max-seconds N]');
    return 1;
  }
  const db = createDbClient(await buildSecretsProvider().getSecret("database-url"));
  const members = await courseLessonOrder(db, courseId);
  if (!members.length) {
    console.error(`Course ${courseId} has no lessons (or doesn't exist)`);
    return 1;
  }

  const files = (await readdir(folder)).filter((f) => f.toLowerCase().endsWith(".txt"));
  const byLesson = new Map(files.map((f) => [f.slice(0, -4), f]));
  const extra = [...byLesson.keys()].filter((id) => !members.includes(id));
  const missing = members.filter((id) => !byLesson.has(id));
  const scripts = [];
  for (const lessonId of members.filter((id) => byLesson.has(id))) {
    const text = (await readFile(join(folder, byLesson.get(lessonId)!), "utf8")).replace(/^\uFEFF/, "").trim();
    if (text) scripts.push({ lessonId, scriptText: text });
    else missing.push(lessonId);
  }

  const dryRun = flag("dry-run");
  const r = await updateCourseScripts(db, courseId, scripts, { dryRun });
  console.log(`${dryRun ? "[dry run] " : ""}${files.length} files · ${scripts.length} scripts for ${members.length} lessons`);
  console.log(`  changed: ${r.scriptsChanged.length} · unchanged: ${r.unchanged.length} · already parsed, now stale: ${r.needsReparse.length}`);
  if (extra.length) console.log(`  not in course, ignored: ${extra.join(", ")}`);
  if (missing.length) console.log(`  no script file (or empty): ${missing.join(", ")}`);
  if (r.needsReparse.length) console.log(`  re-parsing these deletes their translations/audio: ${r.needsReparse.join(", ")}`);
  if (dryRun || !flag("parse")) return 0;

  const rows = await db
    .select({ id: lessons.id, parsedAt: lessons.parsedAt, scriptUpdatedAt: lessons.scriptUpdatedAt, hasScript: lessons.scriptText })
    .from(lessons)
    .where(inArray(lessons.id, members));
  const toParse = members.filter((id) => {
    const l = rows.find((x) => x.id === id);
    return l?.hasScript && (!l.parsedAt || (l.scriptUpdatedAt && l.scriptUpdatedAt > l.parsedAt));
  });
  console.log(`Parsing ${toParse.length} lesson(s)…`);
  const nlpService = new SpacyNlpService(env.SPACY_SERVICE_URL);
  let failed = 0;
  for (const [i, lessonId] of toParse.entries()) {
    if (outOfTime()) {
      console.log(`Stopped (time limit) — ${toParse.length - i} left. Run again to continue.`);
      return 0;
    }
    try {
      const p = await parseLessonSegments({ db, nlpService }, lessonId);
      console.log(`  ${lessonId}: ${p.segmentCount} segments`);
    } catch (err) {
      failed++;
      console.log(`  ${lessonId}: FAILED ${err instanceof Error ? err.message : err}`);
    }
  }
  return failed ? 1 : 0;
});

