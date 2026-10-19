// Adds one saved run to the judge grading sheet (W3-04), and later reveals the judge's scores.
//   pnpm exec tsx evals/judge/runDrafts/addRun.ts dist/<monday>/digest
//     saves each scored draft under evals/judge/<week>/, the judge's scores in
//     evals/judge/scores/<week>.json, and a row per draft to grade in evals/judge/grades.json
//   pnpm exec tsx evals/judge/runDrafts/addRun.ts --reveal
//     fills judgeScore on the weeks whose drafts all have a grade
// Scores stay out of grades.json and the output until then: they must not anchor a grade.
import { realpathSync } from 'node:fs';
import { mkdir, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { DraftsFileSchema } from '../../../src/digest/ending/runFiles/runFiles';
import { readTextIfExists, writeFileAtomic } from '../../../src/shared/atomicFile';
import { DigestError, errorMessage } from '../../../src/shared/errors';
import { RunRecordSchema } from '../../../src/store/runRecord';
import { createGradingSheetTemplate, GradingSheetSchema, type GradingSheet } from '../gradingSheet';
import {
  addToSheet,
  draftsToGrade,
  judgeOf,
  judgeScoresOf,
  JudgeScoresSchema,
  revealScores,
  scoresFile,
} from './runPair';

const JUDGE_DIR = fileURLToPath(new URL('..', import.meta.url));

interface SheetOptions {
  /** Where the drafts and judge scores are saved; defaults to evals/judge. */
  readonly judgeDir?: string;
  /** The sheet to fill; defaults to grades.json in the judge folder. */
  readonly sheetPath?: string;
  readonly log?: (line: string) => void;
}

export interface AddRunOptions extends SheetOptions {
  /** The run folder: dist/<monday>/digest, holding run.json and drafts.json. */
  readonly runDir: string;
}

interface Parser<T> {
  parse(value: unknown): T;
}

/** Parses a file's text, naming the file when it is not JSON or not the expected shape. */
function parsed<T>(path: string, text: string, schema: Parser<T>): T {
  try {
    return schema.parse(JSON.parse(text));
  } catch (error) {
    throw new DigestError(`${path} is not valid: ${errorMessage(error)}`);
  }
}

async function readRequired<T>(path: string, schema: Parser<T>): Promise<T> {
  let text: string;
  try {
    text = await readFile(path, 'utf8');
  } catch (error) {
    throw new DigestError(`Cannot read ${path}: ${errorMessage(error)}`);
  }
  return parsed(path, text, schema);
}

async function readOptional<T>(path: string, schema: Parser<T>): Promise<T | undefined> {
  const text = await readTextIfExists(path);
  return text === undefined ? undefined : parsed(path, text, schema);
}

const pretty = (value: unknown): string => `${JSON.stringify(value, null, 2)}\n`;

/** Writes the file atomically, only when its text changes; returns whether it wrote. */
async function saveIfChanged(path: string, text: string): Promise<boolean> {
  if ((await readTextIfExists(path)) === text) return false;
  await mkdir(dirname(path), { recursive: true });
  await writeFileAtomic(path, text);
  return true;
}

/**
 * Saves the run's scored drafts and their scores, and returns the sheet. Adding the same run
 * again only fills in what is missing: a saved draft, perhaps already graded, is never rewritten.
 */
export async function addRun(options: AddRunOptions): Promise<GradingSheet> {
  const judgeDir = options.judgeDir ?? JUDGE_DIR;
  const sheetPath = options.sheetPath ?? join(judgeDir, 'grades.json');
  const record = await readRequired(join(options.runDir, 'run.json'), RunRecordSchema);
  const { drafts } = await readRequired(join(options.runDir, 'drafts.json'), DraftsFileSchema);
  const judge = judgeOf(record);
  const rows = draftsToGrade(record, drafts);
  const scores = judgeScoresOf(record, judge, rows);
  const scoresPath = join(judgeDir, scoresFile(record.runId));
  const earlier = await readOptional(scoresPath, JudgeScoresSchema);
  if (earlier !== undefined && earlier.runStartedAt !== scores.runStartedAt) {
    throw new DigestError(
      `${record.runId} is already added, from the run started at ${earlier.runStartedAt}. To ` +
        `replace it, delete evals/judge/${record.runId}/, ${scoresFile(record.runId)} and its rows.`,
    );
  }
  const current =
    (await readOptional(sheetPath, GradingSheetSchema)) ?? createGradingSheetTemplate();
  const sheet = addToSheet(current, judge, rows);

  for (const row of rows) {
    const path = join(judgeDir, row.file);
    const fresh =
      (await readTextIfExists(path)) === undefined && (await saveIfChanged(path, row.markdown));
    options.log?.(`${row.week} ${row.writer}: ${fresh ? 'saved' : 'kept'} ${row.draft}`);
  }
  if (earlier === undefined) await saveIfChanged(scoresPath, pretty(scores));
  await saveIfChanged(sheetPath, pretty(sheet));
  options.log?.('Grade each draft in grades.json (humanGrade, picks), then run with --reveal.');
  return sheet;
}

const plural = (count: number, word: string): string => `${count} ${word}${count === 1 ? '' : 's'}`;

/** Fills judgeScore on every fully graded week from its saved scores, and returns the sheet. */
export async function reveal(options: SheetOptions = {}): Promise<GradingSheet> {
  const judgeDir = options.judgeDir ?? JUDGE_DIR;
  const sheetPath = options.sheetPath ?? join(judgeDir, 'grades.json');
  const sheet = await readRequired(sheetPath, GradingSheetSchema);
  const weeks = [...new Set(sheet.digests.flatMap((digest) => digest.week ?? []))];
  const saved = await Promise.all(
    weeks.map((week) => readOptional(join(judgeDir, scoresFile(week)), JudgeScoresSchema)),
  );
  const result = revealScores(
    sheet,
    saved.filter((file) => file !== undefined),
  );
  await saveIfChanged(sheetPath, pretty(result.sheet));
  const revealed = plural(result.revealed, 'judge score');
  options.log?.(`${revealed} revealed, ${plural(result.waiting.length, 'row')} still to grade.`);
  return result.sheet;
}

/** The run folder from the arguments: exactly one, and none with --reveal. */
function runFolderOf(positionals: readonly string[], isReveal: boolean): string | undefined {
  if (isReveal) {
    if (positionals.length > 0) throw new DigestError('--reveal takes no run folder.');
    return undefined;
  }
  const [runDir, ...rest] = positionals;
  if (runDir === undefined) {
    throw new DigestError('Name the run folder, for example dist/2026-10-19/digest.');
  }
  if (rest.length > 0) throw new DigestError('Give one run folder at a time.');
  return runDir;
}

/** The command line: returns the exit code. */
export async function main(
  args: readonly string[],
  log: (line: string) => void = (line) => {
    console.log(line);
  },
  fail: (line: string) => void = (line) => {
    console.error(line);
  },
): Promise<number> {
  try {
    const { values, positionals } = parseArgs({
      args: [...args],
      options: {
        'judge-dir': { type: 'string' },
        sheet: { type: 'string' },
        reveal: { type: 'boolean' },
      },
      allowPositionals: true,
    });
    const paths = {
      log,
      ...(values['judge-dir'] === undefined ? {} : { judgeDir: values['judge-dir'] }),
      ...(values.sheet === undefined ? {} : { sheetPath: values.sheet }),
    };
    const runDir = runFolderOf(positionals, values.reveal === true);
    if (runDir === undefined) await reveal(paths);
    else await addRun({ runDir, ...paths });
    return 0;
  } catch (error) {
    fail(`add-run failed: ${errorMessage(error)}`);
    return 1;
  }
}

// realpath: node resolves symlinks for the entry module, so argv[1] must be resolved the same way.
if (
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href
) {
  process.exitCode = await main(process.argv.slice(2));
}
