// `pnpm tsx evals/feedbackToLabels.ts <week>`: merges dist/feedback/<week>.json into
// evals/weeks/<week>/labels.json (W7-07). Missed items become must-include, wrong picks
// must-exclude. An existing label is never overwritten; a disagreement is printed and left alone.
import { realpathSync } from 'node:fs';
import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { z } from 'zod';
import { WeekIdSchema } from '../src/domain/schemas';
import { DigestError, errorMessage } from '../src/shared/errors';
import { weekDigestDir } from '../src/store/layout';
import { MUST_INCLUDE_COUNT } from './schema';

const DEFAULT_EVALS_DIR = fileURLToPath(new URL('.', import.meta.url));
const DEFAULT_DATA_DIR = 'dist';

const FeedbackFileSchema = z.object({
  weekId: WeekIdSchema,
  wrongPicks: z.array(z.string().min(1)),
  missed: z.array(z.string().min(1)),
});

/** Only the two id lists are checked here; the other fields (notes, ...) are kept as they are. */
const LabelsFileSchema = z.looseObject({
  mustInclude: z.array(z.string()),
  mustExclude: z.array(z.string()).default([]),
});

const NEW_LABELS = { mustInclude: [], mustExclude: [], notes: '' };

export interface FeedbackToLabelsOptions {
  readonly week: string;
  /** The data folder (config dataDir): the week's run and feedback/ (`src/store/layout.ts`). */
  readonly dataDir: string;
  /** The folder with weeks/. */
  readonly evalsDir: string;
}

export interface FeedbackToLabelsDeps {
  /** One report line per call. Default: console.log. */
  readonly log?: (line: string) => void;
}

export interface FeedbackToLabelsResult {
  /** Labels added to the file. */
  readonly added: number;
  /** Feedback that disagrees with an existing label; each is left as it was. */
  readonly conflicts: readonly string[];
  readonly createdWeek: boolean;
}

/** Merges one week's feedback into its labels and returns what changed. Throws a DigestError. */
export async function feedbackToLabels(
  options: FeedbackToLabelsOptions,
  deps: FeedbackToLabelsDeps = {},
): Promise<FeedbackToLabelsResult> {
  const log =
    deps.log ??
    ((line: string) => {
      console.log(line);
    });
  const { dataDir, evalsDir } = options;
  const parsedWeek = WeekIdSchema.safeParse(options.week);
  if (!parsedWeek.success) {
    throw new DigestError(`"${options.week}" is not an ISO week id such as 2026-W42`);
  }
  const week = parsedWeek.data;
  const feedback = await readFeedback(join(dataDir, 'feedback', `${week}.json`), week);
  const weekDir = join(evalsDir, 'weeks', week);
  const labelsPath = join(weekDir, 'labels.json');
  const createdWeek = await ensureWeek(weekDir, join(weekDigestDir(dataDir, week), 'items.json'));
  const existing = await readLabels(labelsPath);

  const include = [...existing.mustInclude];
  const exclude = [...existing.mustExclude];
  const conflicts: string[] = [];
  let added = 0;
  for (const id of feedback.missed) {
    if (exclude.includes(id)) conflicts.push(conflict(id, 'missed', 'must-exclude'));
    else if (!include.includes(id)) {
      include.push(id);
      added += 1;
    }
  }
  for (const id of feedback.wrongPicks) {
    if (include.includes(id)) conflicts.push(conflict(id, 'wrong pick', 'must-include'));
    else if (!exclude.includes(id)) {
      exclude.push(id);
      added += 1;
    }
  }
  const merged = { ...existing, mustInclude: include, mustExclude: exclude };
  await writeFile(labelsPath, `${JSON.stringify(merged, null, 2)}\n`, 'utf8');

  for (const line of conflicts) log(`CONFLICT ${line}`);
  if (include.length !== MUST_INCLUDE_COUNT) {
    log(
      `WARNING: ${week} has ${include.length} must-include ids; digest eval expects exactly ${MUST_INCLUDE_COUNT}. Trim or complete them by hand.`,
    );
  }
  log(
    `${week}: ${added} labels added, ${conflicts.length} conflicts${createdWeek ? ', week folder created' : ''}`,
  );
  return { added, conflicts, createdWeek };
}

function conflict(id: string, said: string, label: string): string {
  return `${id}: feedback says ${said}, but labels say ${label}`;
}

async function readFeedback(
  path: string,
  week: string,
): Promise<z.infer<typeof FeedbackFileSchema>> {
  const raw = await readJson(path, `Run \`digest feedback ${week}\` first`);
  const parsed = FeedbackFileSchema.safeParse(raw);
  if (!parsed.success)
    throw new DigestError(`${path} is not a feedback file: ${parsed.error.message}`);
  if (parsed.data.weekId !== week) {
    throw new DigestError(`${path} is for ${parsed.data.weekId}, not ${week}`);
  }
  return parsed.data;
}

async function readLabels(path: string): Promise<z.infer<typeof LabelsFileSchema>> {
  const parsed = LabelsFileSchema.safeParse(await readJson(path, 'Cannot read the labels'));
  if (!parsed.success)
    throw new DigestError(`${path} is not a labels file: ${parsed.error.message}`);
  return parsed.data;
}

async function readJson(path: string, hint: string): Promise<unknown> {
  try {
    return JSON.parse(await readFile(path, 'utf8'));
  } catch (error) {
    throw new DigestError(`${hint}: cannot read ${path} (${errorMessage(error)})`);
  }
}

/** Makes the week folder from the run's items.json, with empty labels, when it is missing. */
async function ensureWeek(weekDir: string, runItems: string): Promise<boolean> {
  const labelsPath = join(weekDir, 'labels.json');
  if (await exists(labelsPath)) return false;
  await mkdir(weekDir, { recursive: true });
  const itemsPath = join(weekDir, 'items.json');
  if (!(await exists(itemsPath))) {
    try {
      await copyFile(runItems, itemsPath);
    } catch (error) {
      throw new DigestError(
        `Cannot create the week folder: no items.json to copy at ${runItems} (${errorMessage(error)})`,
      );
    }
  }
  await writeFile(labelsPath, `${JSON.stringify(NEW_LABELS, null, 2)}\n`, 'utf8');
  return true;
}

async function exists(path: string): Promise<boolean> {
  try {
    await readFile(path);
    return true;
  } catch {
    return false;
  }
}

// realpath: node resolves symlinks for the entry module, so argv[1] must be resolved the same way.
if (
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href
) {
  const [week = '', dataDir = DEFAULT_DATA_DIR] = process.argv.slice(2);
  feedbackToLabels({ week, dataDir, evalsDir: DEFAULT_EVALS_DIR }).catch((error: unknown) => {
    console.error(`feedbackToLabels failed: ${errorMessage(error)}`);
    process.exitCode = 1;
  });
}
