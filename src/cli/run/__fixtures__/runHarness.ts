import { vi, type Mock } from 'vitest';
import type { AppHandle } from '../../../app/container';
import type { LoadedConfig } from '../../../config/load';
import { PROFILES } from '../../../config/profiles';
import type { DigestDeps, RunResult } from '../../../digest/types';
import { ExitCode } from '../../../domain/schemas';
import type { Delivery } from '../../../delivery/Delivery';
import type { RunRecord } from '../../../store/runRecord';
import { makeConfig, makeRunRecord } from '../../../../test/builders';
import { CapturingDelivery } from '../../../../test/fakes';
import type { RunCommandDeps } from '../run';

// The scripted app and captured output that the `digest run` tests share.

export const DATA_DIR = '/work/data';

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
    configPath: '/work/digest.config.json',
  };
  // The command hands the deps to runDigest and, for a dry run, writes through their channels.
  const appDeps = { config: loaded.config, deliveries } as unknown as DigestDeps;
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
  };
  return { deps, out, err, loadConfig, buildApp, runDigest, close, appDeps, loaded };
}

export const text = (chunks: readonly string[]): string => chunks.join('');
