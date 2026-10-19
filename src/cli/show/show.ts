import { z } from 'zod';
import { parseFile } from './parseFile';
import { ShowError } from './showError';
import { summary } from './summary/summary';
import { draftsTable } from './tables/drafts';
import { itemsTable } from './tables/items';
import { scoresTable } from './tables/scores';
import { clean } from './tables/table';
import { knownSecrets } from '../../app/redaction/knownSecrets';
import { createFsRunStore, type FsRunStoreOptions } from '../../store/adapters/fsRunStore';
import { loadConfig, type LoadedConfig } from '../../config/load';
import { toJson } from '../../digest/ending/runFiles/runFiles';
import { ExitCode, ItemSchema, WEEK_ID_PATTERN } from '../../domain/schemas';
import { type RunRecord } from '../../store/runRecord';
import { createRedactor } from '../../observability/redact';
import type { ArtifactName, RunStore } from '../../store/RunStore';
import { DigestError, errorMessage } from '../../shared/errors';

export interface ShowCommandOptions {
  /** Path to digest.config.json. */
  config?: string;
  week: string;
  part?: string;
  json?: boolean;
}

/** Everything the command touches outside itself; tests replace it, `digest show` uses the defaults. */
export interface ShowCommandDeps {
  loadConfig: (options: { configPath?: string }) => Promise<LoadedConfig>;
  createFsRunStore: (options: FsRunStoreOptions) => RunStore;
  stdout: (text: string) => void;
  stderr: (text: string) => void;
}

const defaultDeps: ShowCommandDeps = {
  loadConfig: (options) => loadConfig(options),
  createFsRunStore,
  stdout: (text) => {
    process.stdout.write(text);
  },
  stderr: (text) => {
    process.stderr.write(text);
  },
};

const PARTS = ['items', 'scores', 'drafts', 'digest', 'run', 'review'] as const;
type Part = (typeof PARTS)[number];

const ARTIFACT_OF: Readonly<Record<Exclude<Part, 'run'>, ArtifactName>> = {
  items: 'items.json',
  scores: 'scores.json',
  drafts: 'drafts.json',
  digest: 'digest.md',
  review: 'review.md',
};

/** `digest show <week>`: prints a saved run's summary or one part of it (W8-07). Returns the exit code. */
export async function showCommand(
  options: ShowCommandOptions,
  deps: Partial<ShowCommandDeps> = {},
): Promise<number> {
  const io: ShowCommandDeps = { ...defaultDeps, ...deps };
  try {
    const part = checkRequest(options);
    const loaded = await io.loadConfig({ configPath: options.config });
    const store = io.createFsRunStore({ dataDir: loaded.config.dataDir });
    const redactor = createRedactor(knownSecrets(loaded.secrets));
    const text = await render(store, options, part);
    io.stdout(redactor.text(clean(text)));
    return ExitCode.Sent;
  } catch (error) {
    io.stderr(`${errorMessage(error)}\n`);
    return error instanceof DigestError ? error.exitCode : ExitCode.Failed;
  }
}

function checkRequest(options: ShowCommandOptions): Part | undefined {
  if (!WEEK_ID_PATTERN.test(options.week)) {
    throw new ShowError(`"${options.week}" is not an ISO week id like 2026-W42`);
  }
  if (options.part === undefined) return undefined;
  const part = PARTS.find((name) => name === options.part);
  if (part === undefined) {
    throw new ShowError(`Unknown part "${options.part}"; use ${PARTS.join(', ')}`);
  }
  return part;
}

const withNewline = (text: string): string => (text.endsWith('\n') ? text : `${text}\n`);

async function render(
  store: RunStore,
  options: ShowCommandOptions,
  part: Part | undefined,
): Promise<string> {
  const week = options.week;
  const record = await store.getRunRecord(week);
  if (part === undefined || part === 'run') {
    if (record === undefined) throw noRun(week);
    return options.json === true || part === 'run' ? toJson(record) : summary(record);
  }
  const name = ARTIFACT_OF[part];
  const raw = await store.readArtifact(week, name);
  if (raw === undefined) throw record === undefined ? noRun(week) : noFile(week, name, record);
  if (options.json === true) return raw;
  if (part === 'digest' || part === 'review') return withNewline(raw);
  return tableOf(part, week, raw, store);
}

const noRun = (week: string): ShowError => new ShowError(`No saved run for ${week}`);

const noFile = (week: string, name: string, record: RunRecord): ShowError =>
  new ShowError(`Week ${week} has no ${name} (run status: ${record.status})`);

async function tableOf(
  part: 'items' | 'scores' | 'drafts',
  week: string,
  raw: string,
  store: RunStore,
): Promise<string> {
  if (part === 'items') return itemsTable(parseFile('items.json', raw, z.array(ItemSchema)));
  if (part === 'scores') return scoresTable(week, raw, store);
  return draftsTable(week, raw, store);
}
