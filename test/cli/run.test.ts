import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi, type Mock } from 'vitest';
import type { AppHandle } from '../../src/app/container.js';
import { runCommand, type RunCommandDeps } from '../../src/cli/run.js';
import type { LoadedConfig } from '../../src/config/load.js';
import { PROFILES } from '../../src/config/profiles.js';
import type { DigestDeps, RunResult } from '../../src/core/runDigest.js';
import { ExitCode, type RunRecord } from '../../src/core/schemas.js';
import { DigestError } from '../../src/shared/errors.js';
import { makeConfig, makeRunRecord } from '../builders.js';

const DATA_DIR = '/work/data';

interface Harness {
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

function sentResult(overrides: Partial<RunRecord> = {}, markdown?: string): RunResult {
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

function harness(result: RunResult | Error = sentResult()): Harness {
  const out: string[] = [];
  const err: string[] = [];
  const loaded: LoadedConfig = {
    config: makeConfig({ dataDir: DATA_DIR }),
    env: { OLLAMA_URL: 'http://localhost:11434', LOG_LEVEL: 'info' },
    secrets: {},
    profile: PROFILES.quality,
    configPath: '/work/digest.config.json',
  };
  // The command only hands the deps to runDigest; a sentinel is enough to check it does.
  const appDeps = { config: loaded.config } as unknown as DigestDeps;
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

const text = (chunks: readonly string[]): string => chunks.join('');

describe('runCommand: wiring', () => {
  it('loads the given config, builds the app and runs the digest on its deps', async () => {
    const h = harness();

    const code = await runCommand({ config: 'my.config.json' }, h.deps);

    expect(code).toBe(0);
    expect(h.loadConfig).toHaveBeenCalledWith({ configPath: 'my.config.json' });
    expect(h.buildApp).toHaveBeenCalledOnce();
    expect(h.runDigest).toHaveBeenCalledWith(h.appDeps, {
      sinceDays: undefined,
      dryRun: undefined,
      force: undefined,
    });
  });

  it('passes --since, --dry-run and --force to runDigest', async () => {
    const h = harness();

    await runCommand({ since: '14d', dryRun: true, force: true }, h.deps);

    expect(h.runDigest).toHaveBeenCalledWith(h.appDeps, {
      sinceDays: 14,
      dryRun: true,
      force: true,
    });
  });

  it('closes the app after a successful run', async () => {
    const h = harness();

    await runCommand({}, h.deps);

    expect(h.close).toHaveBeenCalledOnce();
  });
});

describe('runCommand: --since', () => {
  it.each([
    ['1d', 1],
    ['7d', 7],
    ['31d', 31],
  ])('accepts %s as %i days', async (since, days) => {
    const h = harness();

    const code = await runCommand({ since }, h.deps);

    expect(code).toBe(0);
    expect(h.runDigest).toHaveBeenCalledWith(
      h.appDeps,
      expect.objectContaining({ sinceDays: days }),
    );
  });

  it.each(['0d', '32d', '7', 'd', '7w', '-3d', '1.5d', ' 7d', '7d ', 'abc', ''])(
    'rejects "%s" on stderr with exit code 1 before touching config or models',
    async (since) => {
      const h = harness();

      const code = await runCommand({ since }, h.deps);

      expect(code).toBe(1);
      expect(text(h.err)).toContain('--since');
      expect(text(h.err)).toContain(`"${since}"`);
      expect(text(h.err)).toMatch(/1d.*31d/);
      expect(h.loadConfig).not.toHaveBeenCalled();
      expect(h.buildApp).not.toHaveBeenCalled();
      expect(h.runDigest).not.toHaveBeenCalled();
      expect(h.out).toEqual([]);
    },
  );
});

describe('runCommand: exit codes', () => {
  it.each([
    ['sent', ExitCode.Sent],
    ['failed', ExitCode.Failed],
    ['blocked', ExitCode.Blocked],
    ['quiet', ExitCode.Quiet],
  ] as const)('returns the exit code of a %s result', async (status, exitCode) => {
    const h = harness({ ...sentResult({ status }), exitCode });

    expect(await runCommand({}, h.deps)).toBe(exitCode);
  });

  it('returns the code and message of a DigestError', async () => {
    const h = harness(
      new DigestError('Another run is in progress', { exitCode: ExitCode.Blocked }),
    );

    const code = await runCommand({}, h.deps);

    expect(code).toBe(2);
    expect(text(h.err)).toBe('Another run is in progress\n');
  });

  it('returns 1 for a DigestError without an explicit code', async () => {
    const h = harness(new DigestError('Ollama is not running'));

    expect(await runCommand({}, h.deps)).toBe(1);
    expect(text(h.err)).toBe('Ollama is not running\n');
  });

  it('returns 1 and the message for any other error', async () => {
    const h = harness(new Error('boom'));

    expect(await runCommand({}, h.deps)).toBe(1);
    expect(text(h.err)).toBe('boom\n');
  });

  it('reports a thrown non-Error value', async () => {
    const h = harness();
    h.runDigest.mockRejectedValue('plain string');

    expect(await runCommand({}, h.deps)).toBe(1);
    expect(text(h.err)).toBe('plain string\n');
  });

  it('returns the DigestError code when the config cannot be loaded', async () => {
    const h = harness();
    h.loadConfig.mockRejectedValue(new DigestError('No digest.config.json found'));

    expect(await runCommand({}, h.deps)).toBe(1);
    expect(text(h.err)).toContain('No digest.config.json found');
    expect(h.buildApp).not.toHaveBeenCalled();
  });
});

describe('runCommand: closing the app', () => {
  it('closes the app when runDigest throws', async () => {
    const h = harness(new Error('boom'));

    await runCommand({}, h.deps);

    expect(h.close).toHaveBeenCalledOnce();
  });

  it('closes the app when runDigest throws a DigestError', async () => {
    const h = harness(new DigestError('locked', { exitCode: ExitCode.Blocked }));

    await runCommand({}, h.deps);

    expect(h.close).toHaveBeenCalledOnce();
  });

  it('has nothing to close when the app cannot be built', async () => {
    const h = harness();
    h.buildApp.mockRejectedValue(new Error('Ollama is down'));

    const code = await runCommand({}, h.deps);

    expect(code).toBe(1);
    expect(text(h.err)).toBe('Ollama is down\n');
    expect(h.close).not.toHaveBeenCalled();
  });

  it('reports a failed close without changing the run exit code', async () => {
    const h = harness();
    h.close.mockRejectedValue(new Error('flush failed'));

    const code = await runCommand({}, h.deps);

    expect(code).toBe(0);
    expect(text(h.err)).toContain('flush failed');
    expect(text(h.out)).toContain('2026-W43');
  });

  it('keeps the run error when closing fails too', async () => {
    const h = harness(new DigestError('locked', { exitCode: ExitCode.Blocked }));
    h.close.mockRejectedValue(new Error('flush failed'));

    const code = await runCommand({}, h.deps);

    expect(code).toBe(2);
    expect(text(h.err)).toContain('locked');
    expect(text(h.err)).toContain('flush failed');
  });
});

describe('runCommand: summary', () => {
  it('prints week, status, item counts, winner, digest path and duration for a sent run', async () => {
    const h = harness();

    await runCommand({}, h.deps);

    const summary = text(h.out);
    expect(summary).toMatch(/Week\s+2026-W43/);
    expect(summary).toMatch(/Status\s+sent/);
    expect(summary).toMatch(/Items\s+120 collected → 4 in digest/);
    expect(summary).toMatch(/Winner\s+qwen3\.5:27b/);
    expect(summary).toContain(join(DATA_DIR, 'runs', '2026-W43', 'digest.md'));
    expect(summary).toMatch(/Duration\s+7m 12s/);
    expect(text(h.err)).toBe('');
  });

  it('says that a dry run sent nothing', async () => {
    const h = harness(sentResult({ status: 'dry-run', dryRun: true }));

    await runCommand({ dryRun: true }, h.deps);

    expect(text(h.out)).toMatch(/Status\s+dry-run/);
    expect(text(h.out)).toMatch(/nothing was sent/i);
  });

  it('points at --force when the week was already sent', async () => {
    const h = harness({
      record: makeRunRecord({ runId: '2026-W43', status: 'skipped' }),
      exitCode: ExitCode.Sent,
    });

    const code = await runCommand({}, h.deps);

    expect(code).toBe(0);
    expect(text(h.out)).toMatch(/Status\s+skipped/);
    expect(text(h.out)).toContain('--force');
    expect(text(h.out)).not.toContain('digest.md');
  });

  it('shows no winner and no digest path for a quiet week', async () => {
    const h = harness({
      record: makeRunRecord({ runId: '2026-W43', status: 'quiet', winner: null }),
      exitCode: ExitCode.Quiet,
    });

    const code = await runCommand({}, h.deps);

    expect(code).toBe(3);
    expect(text(h.out)).toMatch(/Status\s+quiet/);
    expect(text(h.out)).toMatch(/Winner\s+-/);
    expect(text(h.out)).not.toContain('digest.md');
  });

  it('prints the error of a failed run on stderr, with its step', async () => {
    const h = harness({
      record: makeRunRecord({
        runId: '2026-W43',
        status: 'failed',
        error: { message: 'No draft passed the link check', step: 'guardOutput' },
      }),
      exitCode: ExitCode.Failed,
    });

    const code = await runCommand({}, h.deps);

    expect(code).toBe(1);
    expect(text(h.out)).toMatch(/Status\s+failed/);
    expect(text(h.err)).toContain('No draft passed the link check');
    expect(text(h.err)).toContain('guardOutput');
  });

  it('lists the failed sources', async () => {
    const h = harness(
      sentResult({
        failedSources: [{ sourceId: 'broken-feed', error: 'timeout after 10 s' }],
      }),
    );

    await runCommand({}, h.deps);

    expect(text(h.out)).toContain('broken-feed');
    expect(text(h.out)).toContain('timeout after 10 s');
  });

  it('shows durations under a minute in seconds', async () => {
    const h = harness(
      sentResult({ startedAt: '2026-10-19T05:45:00Z', finishedAt: '2026-10-19T05:45:07.500Z' }),
    );

    await runCommand({}, h.deps);

    expect(text(h.out)).toMatch(/Duration\s+7\.5s/);
  });
});

describe('runCommand: rejected drafts', () => {
  it('names the drafts that were rejected and by which check', async () => {
    const h = harness({
      record: makeRunRecord({
        runId: '2026-W43',
        status: 'blocked',
        drafts: [
          { writer: 'qwen3.5:27b', passed: false, rejectedBy: ['linkCheck', 'formatCheck'] },
          { writer: 'gemma4:31b', passed: true, rejectedBy: [] },
        ],
      }),
      exitCode: ExitCode.Blocked,
    });

    const code = await runCommand({}, h.deps);

    expect(code).toBe(2);
    expect(text(h.out)).toContain('Rejected draft: qwen3.5:27b (linkCheck, formatCheck)');
    expect(text(h.out)).not.toContain('gemma4:31b');
  });
});

describe('runCommand: secrets', () => {
  const secrets = { SMTP_PASSWORD: 'hunter2-smtp', GITHUB_TOKEN: 'ghp_token123' };

  it('redacts secrets from a thrown error', async () => {
    const h = harness(new Error('SMTP login failed for hunter2-smtp'));
    h.loadConfig.mockResolvedValue({ ...h.loaded, secrets });

    const code = await runCommand({}, h.deps);

    expect(code).toBe(1);
    expect(text(h.err)).toBe('SMTP login failed for [redacted]\n');
  });

  it('redacts secrets from the summary and the run error', async () => {
    const h = harness(
      sentResult({
        status: 'failed',
        failedSources: [{ sourceId: 'gh', error: 'bad credentials ghp_token123' }],
        error: { message: 'delivery failed: hunter2-smtp', step: 'deliver' },
      }),
    );
    h.loadConfig.mockResolvedValue({ ...h.loaded, secrets });

    await runCommand({}, h.deps);

    expect(text(h.out)).toContain('bad credentials [redacted]');
    expect(text(h.err)).toContain('delivery failed: [redacted]');
    expect(text(h.out) + text(h.err)).not.toMatch(/hunter2-smtp|ghp_token123/);
  });
});

describe('runCommand: default dependencies', () => {
  it('reports a missing config on the process stderr', async () => {
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);

    const code = await runCommand({ config: join(tmpdir(), 'digest-no-such-dir', 'x.json') });

    expect(code).toBe(1);
    expect(stderr).toHaveBeenCalledWith(expect.stringContaining('digest init'));
  });
});
