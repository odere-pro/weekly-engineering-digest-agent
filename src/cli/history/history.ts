import { createFsRunStore, type FsRunStoreOptions } from '../../store/adapters/fsRunStore';
import { loadConfig, type LoadedConfig } from '../../config/load';
import { ExitCode } from '../../domain/schemas';
import { type RunRecord } from '../../store/runRecord';
import type { RunStore } from '../../store/RunStore';
import { DigestError, errorMessage } from '../../shared/errors';

export interface HistoryCommandOptions {
  /** Path to digest.config.json. */
  config?: string;
  limit?: number;
}

/** Everything the command touches outside itself; tests replace it, `digest history` uses the defaults. */
export interface HistoryCommandDeps {
  loadConfig: (options: { configPath?: string }) => Promise<LoadedConfig>;
  createFsRunStore: (options: FsRunStoreOptions) => RunStore;
  stdout: (text: string) => void;
  stderr: (text: string) => void;
}

const DEFAULT_LIMIT = 12;
const COLUMN_GAP = '  ';
const MS_PER_SECOND = 1000;
const SECONDS_PER_MINUTE = 60;
const MINUTES_PER_HOUR = 60;
const TENTHS_PER_SECOND = 10;

const defaultDeps: HistoryCommandDeps = {
  loadConfig: (options) => loadConfig(options),
  createFsRunStore,
  stdout: (text) => {
    process.stdout.write(text);
  },
  stderr: (text) => {
    process.stderr.write(text);
  },
};

/** `digest history`: Lists past runs with status, item counts and duration (W1-17). Returns the process exit code. */
export async function historyCommand(
  options: HistoryCommandOptions,
  deps: Partial<HistoryCommandDeps> = {},
): Promise<number> {
  const io: HistoryCommandDeps = { ...defaultDeps, ...deps };
  try {
    const loaded = await io.loadConfig({ configPath: options.config });
    const store = io.createFsRunStore({ dataDir: loaded.config.dataDir });
    const runs = await store.listRuns(options.limit ?? DEFAULT_LIMIT);
    io.stdout(runs.length === 0 ? 'No runs yet.\n' : `${formatRunTable(runs)}\n`);
    return ExitCode.Sent;
  } catch (error) {
    io.stderr(`${errorMessage(error)}\n`);
    return error instanceof DigestError ? error.exitCode : ExitCode.Failed;
  }
}

/** Week, status, collected → digest items, duration and winner, one run per line. */
function formatRunTable(runs: readonly RunRecord[]): string {
  const header = ['Week', 'Status', 'Items', 'Duration', 'Winner'];
  const rows = [
    header,
    ...runs.map((run) => [
      run.runId,
      run.status,
      `${run.counts.collected} → ${run.counts.digestItems}`,
      formatRunDuration(run),
      run.winner ?? '-',
    ]),
  ];
  const widths = header.map((_, col) => Math.max(...rows.map((row) => row[col]?.length ?? 0)));
  return rows
    .map((row) =>
      row
        .map((cell, col) => cell.padEnd(widths[col] ?? 0))
        .join(COLUMN_GAP)
        .trimEnd(),
    )
    .join('\n');
}

/** How long a run took, from its own timestamps. */
export function formatRunDuration(record: Pick<RunRecord, 'startedAt' | 'finishedAt'>): string {
  return formatDuration(Date.parse(record.finishedAt) - Date.parse(record.startedAt));
}

/** "7.5s" under a minute, "7m 12s" under an hour, "2h 15m" above; a negative span counts as zero. */
export function formatDuration(ms: number): string {
  const clamped = Math.max(0, ms);
  const seconds = Math.floor(clamped / MS_PER_SECOND);
  const minutes = Math.floor(seconds / SECONDS_PER_MINUTE);
  if (minutes === 0) {
    const tenths = Math.floor(clamped / (MS_PER_SECOND / TENTHS_PER_SECOND));
    return `${(tenths / TENTHS_PER_SECOND).toFixed(1)}s`;
  }
  const hours = Math.floor(minutes / MINUTES_PER_HOUR);
  if (hours === 0) return `${minutes}m ${seconds % SECONDS_PER_MINUTE}s`;
  return `${hours}h ${minutes % MINUTES_PER_HOUR}m`;
}
