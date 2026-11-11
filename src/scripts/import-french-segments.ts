/**
 * One-time import: legacy French sentence scripts -> segment_translations (fr),
 * aligned to the existing English lesson_segments. No DeepL calls.
 *
 * Usage:
 *   npm run french:import -- --dir "C:\Translations\Essential for Parts" [--dry-run] [--lesson 25SWEssParts01_02] [--overwrite] [--out ./french-import-report]
 *
 * DB connection comes from ISecretsProvider ("database-url"), like the other CLI scripts.
 *
 * Per lesson: file stem == lessons.id, loads English segments,
 * aligns, and inserts in ONE transaction. Output is exactly one French segment per English
 * segment, built only from the French sentence file. Matching is loose; a segment with no
 * counterpart in the files gets NO row (never an empty string, which would produce a silent
 * clip) and is listed in the report. A lesson is skipped only when its script clearly does not
 * match the DB segments, the sentence counts differ, or a lookup fails.
 */
import { promises as fs } from "node:fs";
import path from "node:path";
import postgres from "postgres";
import { buildSecretsProvider } from "../plugins/secrets-provider.js";
import { alignSegments, type AlignedSegment, type EnglishSegment, parseNumberedScript } from "./align-french.js";

const TARGET_LANGUAGE = "fr";

interface CliOptions {
  dir: string;
  outDir: string;
  dryRun: boolean;
  overwrite: boolean;
  onlyLesson?: string;
}

interface LessonReport {
  stem: string;
  lessonId: string;
  status: "imported" | "dry-run-ok" | "skipped";
  reason: string;
  segments: number; // English segments in DB
  written: number; // French segments produced (rows written, or that would be)
  missing: number; // segments with no French counterpart
  low: number; // segments flagged for review (low similarity)
  score: number; // mean similarity
  sentences: number;
  warnings: string[];
}

interface ILessonRepository {
  lessonExists(lessonId: string): Promise<boolean>;
  getEnglishSegments(lessonId: string): Promise<EnglishSegment[]>;
  countExistingFrench(lessonId: string): Promise<number>;
  saveFrench(rows: AlignedSegment[], overwrite: boolean): Promise<void>; // rows with text only
}

class PgLessonRepository implements ILessonRepository {
  constructor(private readonly sql: postgres.Sql) {}

  async lessonExists(lessonId: string): Promise<boolean> {
    const rows = await this.sql`select 1 from lessons where id = ${lessonId}`;
    return rows.length > 0;
  }

  async getEnglishSegments(lessonId: string): Promise<EnglishSegment[]> {
    const rows = await this.sql<{ id: string; sequence_index: number; text: string }[]>`
      select id, sequence_index, text from lesson_segments where lesson_id = ${lessonId} order by sequence_index`;
    return rows.map((r) => ({ id: r.id, sequenceIndex: r.sequence_index, text: r.text }));
  }

  async countExistingFrench(lessonId: string): Promise<number> {
    const rows = await this.sql<{ n: number }[]>`
      select count(*)::int as n from segment_translations t
        join lesson_segments s on s.id = t.segment_id
       where s.lesson_id = ${lessonId} and t.target_language = ${TARGET_LANGUAGE}`;
    return rows[0].n;
  }

  async saveFrench(rows: AlignedSegment[], overwrite: boolean): Promise<void> {
    await this.sql.begin(async (tx) => {
      for (const r of rows) {
        // deepl_glossary_id / context_used / formality / billed_characters stay NULL: DeepL was not used.
        if (overwrite) {
          await tx`insert into segment_translations (segment_id, target_language, translated_text)
                   values (${r.segmentId}, ${TARGET_LANGUAGE}, ${r.frenchText})
                   on conflict (segment_id, target_language) do update set translated_text = excluded.translated_text`;
        } else {
          await tx`insert into segment_translations (segment_id, target_language, translated_text)
                   values (${r.segmentId}, ${TARGET_LANGUAGE}, ${r.frenchText})
                   on conflict (segment_id, target_language) do nothing`;
        }
      }
    });
  }
}

function parseArgs(argv: string[]): CliOptions {
  const get = (flag: string) => {
    const i = argv.indexOf(flag);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const dir = get("--dir");
  if (!dir) throw new Error('--dir is required, e.g. --dir "C:\\Translations\\Essential for Parts"');
  return {
    dir,
    outDir: get("--out") ?? "./french-import-report",
    dryRun: argv.includes("--dry-run"),
    overwrite: argv.includes("--overwrite"),
    onlyLesson: get("--lesson"),
  };
}

async function processLesson(stem: string, opts: CliOptions, repo: ILessonRepository, alignmentRows: string[][]): Promise<LessonReport> {
  const base: LessonReport = { stem, lessonId: "", status: "skipped", reason: "", segments: 0, written: 0, missing: 0, low: 0, score: 0, sentences: 0, warnings: [] };
  const skip = (reason: string): LessonReport => ({ ...base, reason });

  const [enRaw, frRaw] = await Promise.all([
    fs.readFile(path.join(opts.dir, `${stem}.txt`), "utf8"),
    fs.readFile(path.join(opts.dir, `${stem}_fr.txt`), "utf8"),
  ]);
  const en = parseNumberedScript(enRaw);
  const fr = parseNumberedScript(frRaw);
  base.sentences = en.sentences.length;
  base.warnings = [...en.warnings.map((w) => `EN ${w}`), ...fr.warnings.map((w) => `FR ${w}`)];

  const lessonId = stem;
  if (!(await repo.lessonExists(lessonId))) return skip("no lessons row with id = file name");
  base.lessonId = lessonId;

  const segments = await repo.getEnglishSegments(lessonId);
  if (segments.length === 0) return skip("lesson has no English segments in lesson_segments");
  base.segments = segments.length;

  if (!opts.overwrite && (await repo.countExistingFrench(lessonId)) > 0) {
    return skip("French translations already exist (use --overwrite to replace)");
  }

  const result = alignSegments(segments, en.sentences, fr.sentences);
  if (!result.ok) return skip(result.reason);

  result.segments.forEach((s) =>
    alignmentRows.push([stem, String(s.sequenceIndex), s.status, s.status === "missing" ? "" : `${s.firstSentence}-${s.lastSentence}`, s.similarity.toFixed(3), s.englishText, s.frenchText]),
  );
  base.warnings.push(...result.warnings);

  const toWrite = result.segments.filter((s) => s.status !== "missing");
  const stats = {
    written: toWrite.length,
    missing: result.segments.length - toWrite.length,
    low: result.segments.filter((s) => s.status === "low").length,
    score: result.lessonScore,
  };
  const note = stats.missing || stats.low ? `${stats.missing} missing, ${stats.low} low-similarity (see alignment.csv)` : "ok";

  if (opts.dryRun) return { ...base, ...stats, status: "dry-run-ok", reason: `aligned (dry run); ${note}` };
  await repo.saveFrench(toWrite, opts.overwrite);
  return { ...base, ...stats, status: "imported", reason: note };
}

const csv = (rows: string[][]): string =>
  rows.map((r) => r.map((c) => `"${c.replace(/"/g, '""')}"`).join(",")).join("\r\n");

async function main(): Promise<void> {
  const opts = parseArgs(process.argv.slice(2));
  const sql = postgres(await buildSecretsProvider().getSecret("database-url"));
  const repo = new PgLessonRepository(sql);

  const files = await fs.readdir(opts.dir);
  const stems = files
    .filter((f) => f.endsWith("_fr.txt"))
    .map((f) => f.replace(/_fr\.txt$/, ""))
    .filter((s) => !opts.onlyLesson || s === opts.onlyLesson)
    .sort();

  const reports: LessonReport[] = [];
  const alignmentRows: string[][] = [["lesson", "segment_index", "status", "sentences", "similarity", "english", "french"]];
  for (const stem of stems) {
    try {
      reports.push(await processLesson(stem, opts, repo, alignmentRows));
    } catch (err) {
      reports.push({ stem, lessonId: "", status: "skipped", reason: `error: ${(err as Error).message}`, segments: 0, written: 0, missing: 0, low: 0, score: 0, sentences: 0, warnings: [] });
    }
    const r = reports[reports.length - 1];
    console.log(`${r.status.padEnd(10)} ${stem}  ${r.reason}`);
  }

  await fs.mkdir(opts.outDir, { recursive: true });
  await fs.writeFile(
    path.join(opts.outDir, "lessons.csv"),
    csv([
      ["lesson", "lesson_id", "status", "reason", "en_segments", "fr_segments", "missing", "low", "mean_similarity", "sentences", "warnings"],
      ...reports.map((r) => [r.stem, r.lessonId, r.status, r.reason, String(r.segments), String(r.written), String(r.missing), String(r.low), r.score.toFixed(3), String(r.sentences), r.warnings.join(" | ")]),
    ]),
  );
  await fs.writeFile(path.join(opts.outDir, "alignment.csv"), csv(alignmentRows));

  const done = reports.filter((r) => r.status !== "skipped");
  const totalSeg = done.reduce((a, r) => a + r.segments, 0);
  const totalFr = done.reduce((a, r) => a + r.written, 0);
  console.log(`\n${done.length}/${reports.length} lessons ${opts.dryRun ? "aligned (dry run)" : "imported"}; ${reports.length - done.length} skipped.`);
  console.log(`French segments: ${totalFr}/${totalSeg} English segments covered (${totalSeg ? ((100 * totalFr) / totalSeg).toFixed(1) : "0"}%). Reports in ${opts.outDir}`);
  await sql.end();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
