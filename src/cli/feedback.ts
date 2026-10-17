import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createFsRunStore, type FsRunStoreOptions } from '../adapters/store/fsRunStore.js';
import { loadConfig, type LoadedConfig } from '../config/load.js';
import { parseReviewSheet } from '../core/reviewSheet.js';
import { ExitCode, WeekIdSchema } from '../core/schemas.js';
import type { RunStore } from '../ports/RunStore.js';
import { DigestError, errorMessage } from '../shared/errors.js';

export interface FeedbackCommandOptions {
  /** The ISO week whose review sheet to read, e.g. 2026-W42. */
  week: string;
  /** Path to digest.config.json. */
  config?: string;
}

/** Everything the command touches outside itself; tests replace it, `digest feedback` uses the defaults. */
export interface FeedbackCommandDeps {
  loadConfig: (options: { configPath?: string }) => Promise<LoadedConfig>;
  createFsRunStore: (options: FsRunStoreOptions) => RunStore;
  mkdir: (path: string) => Promise<void>;
  writeFile: (path: string, content: string) => Promise<void>;
  stdout: (text: string) => void;
  stderr: (text: string) => void;
}

const FEEDBACK_DIR = 'feedback';

const defaultDeps: FeedbackCommandDeps = {
  loadConfig: (options) => loadConfig(options),
  createFsRunStore,
  mkdir: async (path) => {
    await mkdir(path, { recursive: true });
  },
  writeFile: (path, content) => writeFile(path, content, 'utf8'),
  stdout: (text) => {
    process.stdout.write(text);
  },
  stderr: (text) => {
    process.stderr.write(text);
  },
};

/**
 * `digest feedback <week>` (W7-07): reads the ticks in data/runs/<week>/review.md and writes
 * data/feedback/<week>.json. Returns the process exit code.
 */
export async function feedbackCommand(
  options: FeedbackCommandOptions,
  deps: Partial<FeedbackCommandDeps> = {},
): Promise<number> {
  const io: FeedbackCommandDeps = { ...defaultDeps, ...deps };
  try {
    const week = parseWeek(options.week);
    const loaded = await io.loadConfig({ configPath: options.config });
    const { dataDir } = loaded.config;
    const sheet = await io.createFsRunStore({ dataDir }).readArtifact(week, 'review.md');
    if (sheet === undefined) {
      throw new DigestError(
        `No review sheet for ${week}: run the week first (${join(dataDir, 'runs', week, 'review.md')})`,
      );
    }
    const feedback = parseReviewSheet(sheet);
    if (feedback.weekId !== week) {
      throw new DigestError(
        `The sheet in data/runs/${week} is for ${feedback.weekId}, not ${week}`,
      );
    }
    const dir = join(dataDir, FEEDBACK_DIR);
    await io.mkdir(dir);
    await io.writeFile(join(dir, `${week}.json`), `${JSON.stringify(feedback, null, 2)}\n`);
    const { wrongPicks, missed } = feedback;
    io.stdout(
      `${week}: ${count(wrongPicks.length, 'wrong pick')}, ${missed.length} missed -> ${join(dir, `${week}.json`)}\n`,
    );
    return ExitCode.Sent;
  } catch (error) {
    io.stderr(`${errorMessage(error)}\n`);
    return error instanceof DigestError ? error.exitCode : ExitCode.Failed;
  }
}

function parseWeek(week: string): string {
  const parsed = WeekIdSchema.safeParse(week);
  if (!parsed.success) {
    throw new DigestError(`"${week}" is not an ISO week id such as 2026-W42`);
  }
  return parsed.data;
}

function count(n: number, noun: string): string {
  return `${n} ${noun}${n === 1 ? '' : 's'}`;
}
