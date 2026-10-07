// src/scripts/load-scripts.ts
//
// Loads a course's English scripts from a folder of .txt files named by
// lesson id (25Sim01_01.txt), then optionally parses them into segments:
//
//   npm run scripts:load -- 25Sim "C:\path\to\scripts" --proofread --dry-run
//   npm run scripts:load -- 25Sim "C:\path\to\scripts" --proofread --parse [--max-seconds 600]
//
// --proofread: Claude proposes fixes for clear errors (run-together
// sentences, typos, missing/doubled words) before anything is saved; only
// mechanical fixes are applied, the rest are listed for review. The report
// goes to <folder>/_proofread-report.md (also on --dry-run). A file that
// hasn't changed since it was last proofread keeps its stored fixes and
// isn't proofread again.
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
import { updateCourseScripts, type CourseScriptInput } from "../services/catalog/updateCourseScripts.js";
import { writeFile } from "node:fs/promises";
import { applyScriptCorrections, type ProofreadOutcome } from "../services/proofreading/applyScriptCorrections.js";
import { ClaudeScriptProofreader } from "../services/proofreading/ClaudeScriptProofreader.js";
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
  const secrets = buildSecretsProvider();
  const db = createDbClient(await secrets.getSecret("database-url"));
  const members = await courseLessonOrder(db, courseId);
  if (!members.length) {
    console.error(`Course ${courseId} has no lessons (or doesn't exist)`);
    return 1;
  }

  const files = (await readdir(folder)).filter((f) => f.toLowerCase().endsWith(".txt"));
  const byLesson = new Map(files.map((f) => [f.slice(0, -4), f]));
  const extra = [...byLesson.keys()].filter((id) => !members.includes(id));
  const missing = members.filter((id) => !byLesson.has(id));
  const raw = new Map<string, string>();
  for (const lessonId of members.filter((id) => byLesson.has(id))) {
    const text = (await readFile(join(folder, byLesson.get(lessonId)!), "utf8")).replace(/^\uFEFF/, "").trim();
    if (text) raw.set(lessonId, text);
    else missing.push(lessonId);
  }

  // A source already proofread (same file text) keeps its stored fixes.
  const stored = new Map(
    (await db.select({ id: lessons.id, scriptText: lessons.scriptText, source: lessons.scriptSourceText }).from(lessons).where(inArray(lessons.id, [...raw.keys()])))
      .map((r) => [r.id, r])
  );
  const scripts: CourseScriptInput[] = [];
  const toProofread: string[] = [];
  for (const [lessonId, text] of raw) {
    const s = stored.get(lessonId);
    if (s?.source === text && s.scriptText) scripts.push({ lessonId, scriptText: s.scriptText, sourceText: text });
    else if (flag("proofread")) toProofread.push(lessonId);
    else scripts.push({ lessonId, scriptText: text, sourceText: null });
  }

  if (toProofread.length) {
    console.log(`Proofreading ${toProofread.length} script(s)…`);
    const proofreader = new ClaudeScriptProofreader(secrets, env.ANTHROPIC_REVIEW_MODEL);
    const outcomes = new Map<string, ProofreadOutcome>();
    const errors = new Map<string, string>();
    for (let i = 0; i < toProofread.length; i += 6) {
      await Promise.all(
        toProofread.slice(i, i + 6).map(async (lessonId) => {
          try {
            const text = raw.get(lessonId)!;
            outcomes.set(lessonId, applyScriptCorrections(text, await proofreader.proofread({ lessonId, text })));
          } catch (err) {
            errors.set(lessonId, err instanceof Error ? err.message : String(err));
          }
        })
      );
    }
    for (const lessonId of toProofread) {
      const o = outcomes.get(lessonId);
      if (o) scripts.push({ lessonId, scriptText: o.text, sourceText: raw.get(lessonId)! });
    }
    const n = (k: "applied" | "review" | "skipped") => [...outcomes.values()].reduce((sum, o) => sum + o[k].length, 0);
    console.log(`  fixes applied: ${n("applied")} · for review: ${n("review")} · no exact match: ${n("skipped")}`);
    for (const [id, e] of errors) console.log(`  ${id}: proofreading FAILED (not loaded) — ${e}`);
    await writeFile(join(folder, "_proofread-report.md"), proofreadReport(courseId, outcomes, errors, flag("dry-run")));
    console.log(`  report: ${join(folder, "_proofread-report.md")}`);
  }

  const dryRun = flag("dry-run");
  scripts.sort((x, y) => members.indexOf(x.lessonId) - members.indexOf(y.lessonId));
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

function proofreadReport(courseId: string, outcomes: Map<string, ProofreadOutcome>, errors: Map<string, string>, dryRun: boolean): string {
  const cell = (t: string) => t.replace(/\|/g, "\\|").replace(/\s*\n\s*/g, " ").trim();
  const rows: string[] = [];
  for (const [id, o] of [...outcomes].sort(([a], [b]) => a.localeCompare(b))) {
    for (const c of o.applied) rows.push(`| ${id} | Applied | ${cell(c.reason)} | ${cell(c.original)} | ${cell(c.corrected)} |`);
    for (const c of o.review) rows.push(`| ${id} | **Review** (${cell(c.why)}) | ${cell(c.reason)} | ${cell(c.original)} | ${cell(c.corrected)} |`);
    for (const c of o.skipped) rows.push(`| ${id} | Skipped (${cell(c.why)}) | ${cell(c.reason)} | ${cell(c.original)} | ${cell(c.corrected)} |`);
  }
  return [
    `# ${courseId} script proofreading${dryRun ? " (dry run — nothing saved)" : ""}`,
    "",
    `${new Date().toISOString()}. Applied = mechanical fix, saved to the database (the .txt files are not changed). Review = not applied; fix the .txt by hand if you agree, then load again.`,
    "",
    "| Script | Status | Reason | Original | Proposed |",
    "|---|---|---|---|---|",
    ...rows,
    ...(errors.size ? ["", "## Proofreading failed (scripts not loaded)", ...[...errors].map(([id, e]) => `- ${id}: ${cell(e)}`)] : []),
    "",
  ].join("\r\n");
}
