import { vi, type Mock } from 'vitest';
import type { AppHandle } from '../../../app/container';
import type { LoadedConfig } from '../../../config/load';
import { PROFILES } from '../../../config/profiles';
import type { DigestDeps, RunResult } from '../../../digest/types';
import { ExitCode } from '../../../domain/schemas';
import type { Delivery } from '../../../delivery/Delivery';
import type { RunRecord } from '../../../store/runRecord';
import { makeConfig, makeRunRecord } from '../../../../test/builders';
import { CapturingDelivery, MemoryRunStore, fixedClock } from '../../../../test/fakes';
import { scriptedPrompts, type PromptCall, type Rule } from '../../init/__fixtures__/initHarness';
import type { RunCommandDeps } from '../run';

// The scripted app and captured output that the `digest run` tests share.

export const DATA_DIR = '/work/data';
export const CONFIG_PATH = '/work/digest.config.json';
/** A Wednesday in ISO week 2026-W43. */
const NOW = '2026-10-21T10:00:00Z';

export interface Harness {
  deps: RunCommandDeps;
  out: string[];
  err: string[];
  loadConfig: Mock<RunCommandDeps['loadConfig']>;
  buildApp: Mock<RunCommandDeps['buildApp']>;
  runDigest: Mock<RunCommandDeps['runDigest']>;
  close: Mock<AppHandle['close']>;
  appDeps: DigestDeps;
  loaded: LoadedConfig;
  /** The run history `createStore` hands out; seed it with `store.records` and `store.artifacts`. */
  store: MemoryRunStore;
  /** The questions asked, in order. */
  calls: PromptCall[];
  /** The files `writeFile` wrote, by path. */
  written: Map<string, string>;
}

export function sentResult(overrides: Partial<RunRecord> = {}, markdown?: string): RunResult {
  return {
    record: makeRunRecord({
      runId: '2026-W43',
      status: 'sent',
      startedAt: '2026-10-19T05:45:00Z',
      finishedAt: '2026-10-19T05:52:12Z',
      counts: {
        collected: 120,
        afterGuardInput: 118,
        classified: 118,
        selected: 5,
        digestItems: 4,
      },
      winner: 'qwen3.5:27b',
      ...overrides,
    }),
    exitCode: ExitCode.Sent,
    markdown: markdown ?? '# Digest\n',
  };
}

export interface HarnessOptions {
  /** The channels the app has; default: one capturing Markdown channel. */
  deliveries?: readonly Delivery[];
  /** delivery.markdown.dir in the loaded config; default: the schema default. */
  markdownDir?: string;
  /** dataDir in the loaded config; default: DATA_DIR. */
  dataDir?: string;
  /** Whether a person can answer; default: false (no menu). */
  interactive?: boolean;
  /** The scripted user's answers, by prompt message; no rule means Enter. */
  rules?: readonly Rule[];
  /** The config file's text, for the save-sources step. */
  configText?: string;
  /** Replaces the scripted user, for a prompt that throws. */
  prompts?: RunCommandDeps['prompts'];
}

export function harness(
  result: RunResult | Error = sentResult(),
  options: HarnessOptions = {},
): Harness {
  const out: string[] = [];
  const err: string[] = [];
  const { markdownDir, deliveries = [new CapturingDelivery('markdown')] } = options;
  const loaded: LoadedConfig = {
    config: makeConfig({
      dataDir: options.dataDir ?? DATA_DIR,
      ...(markdownDir !== undefined && { delivery: { markdown: { dir: markdownDir } } }),
    }),
    env: { OLLAMA_URL: 'http://localhost:11434', LOG_LEVEL: 'info' },
    secrets: {},
    profile: PROFILES.quality,
    platform: { os: 'darwin', arch: 'arm64' },
    configPath: CONFIG_PATH,
  };
  const store = new MemoryRunStore();
  const scripted = scriptedPrompts(options.rules);
  const written = new Map<string, string>();
  const configFile = options.configText;
  // The command hands the deps to runDigest and, for a dry run, writes through their channels.
  const appDeps = {
    config: loaded.config,
    deliveries,
    store,
    clock: fixedClock(NOW),
  } as unknown as DigestDeps;
  const close = vi.fn<AppHandle['close']>(() => Promise.resolve());
  const loadConfig = vi.fn<RunCommandDeps['loadConfig']>(() => Promise.resolve(loaded));
  const buildApp = vi.fn<RunCommandDeps['buildApp']>(() =>
    Promise.resolve({ deps: appDeps, close }),
  );
  const runDigest = vi.fn<RunCommandDeps['runDigest']>(() =>
    result instanceof Error ? Promise.reject(result) : Promise.resolve(result),
  );
  const deps: RunCommandDeps = {
    loadConfig,
    buildApp,
    runDigest,
    stdout: (text) => out.push(text),
    stderr: (text) => err.push(text),
    prompts: options.prompts ?? scripted.prompts,
    interactive: options.interactive ?? false,
    createStore: () => store,
    clock: fixedClock(NOW),
    readFile: (path) => Promise.resolve(path === CONFIG_PATH ? configFile : undefined),
    writeFile: (path, content) => {
      written.set(path, content);
      return Promise.resolve();
    },
  };
  return {
    deps,
    out,
    err,
    loadConfig,
    buildApp,
    runDigest,
    close,
    appDeps,
    loaded,
    store,
    calls: scripted.calls,
    written,
  };
}

export const text = (chunks: readonly string[]): string => chunks.join('');

/** A digest a second run built: the message `runDigest` returns for a variant. */
export function variantResult(
  slug: string,
  urls: readonly string[] = ['https://example.com/a'],
  overrides: Partial<RunRecord> = {},
): RunResult {
  const base = sentResult({ status: 'dry-run', dryRun: true, ...overrides });
  const markdown = `# Digest\n${urls.map((url) => `[item](${url})`).join('\n')}\n`;
  return {
    ...base,
    exitCode: ExitCode.Sent,
    markdown,
    message: {
      weekId: base.record.runId,
      subject: `Engineering digest ${base.record.runId} (${slug})`,
      markdown,
      variant: slug,
      view: {
        weekId: base.record.runId,
        title: 'Week',
        headline: 'Headline',
        groups: [
          {
            urgency: 'act-now',
            label: 'Act now',
            items: urls.map((url) => ({ title: 'item', url, whatChanged: 'It changed.' })),
          },
        ],
      },
    },
  };
}
