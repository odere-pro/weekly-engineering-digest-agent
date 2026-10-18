import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import { createMarkdownFileDelivery } from '../../delivery/adapters/markdownFile';
import type { AppHandle } from '../../app/container';
import { runCommand, type RunCommandDeps } from './run';
import type { LoadedConfig } from '../../config/load';
import { PROFILES } from '../../config/profiles';
import type { DigestDeps, RunResult } from '../../digest/runDigest';
import { ExitCode } from '../../domain/schemas';
import { type RunRecord } from '../../store/runRecord';
import type { Delivery, DigestMessage, DigestView } from '../../delivery/Delivery';
import { DigestError } from '../../shared/errors';
import { makeConfig, makeRunRecord } from '../../../test/builders';
import { CapturingDelivery } from '../../../test/fakes';

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

interface HarnessOptions {
  /** The channels the app has; default: one capturing Markdown channel. */
  deliveries?: readonly Delivery[];
  /** delivery.markdown.dir in the loaded config; default: the schema default. */
  markdownDir?: string;
}

function harness(result: RunResult | Error = sentResult(), options: HarnessOptions = {}): Harness {
  const out: string[] = [];
  const err: string[] = [];
  const { markdownDir, deliveries = [new CapturingDelivery('markdown')] } = options;
  const loaded: LoadedConfig = {
    config: makeConfig({
      dataDir: DATA_DIR,
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

  it('lets --seed override models.seed for the app it builds', async () => {
    const h = harness();

    await runCommand({ seed: 7 }, h.deps);

    const built = h.buildApp.mock.calls[0]![0];
    expect(built.config.models.seed).toBe(7);
    expect(h.loaded.config.models.seed).toBe(42);
  });

  it('keeps the configured seed without --seed', async () => {
    const h = harness();

    await runCommand({}, h.deps);

    expect(h.buildApp.mock.calls[0]![0]).toBe(h.loaded);
  });

  it.each([-1, 1.5, Number.NaN])('exits 1 with a message for --seed %s', async (seed) => {
    const h = harness();

    const code = await runCommand({ seed }, h.deps);

    expect(code).toBe(1);
    expect(text(h.err)).toMatch(/Invalid --seed/);
    expect(h.buildApp).not.toHaveBeenCalled();
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

  it('says why the week kept its files, under the summary, and names no digest path', async () => {
    const kept = 'Kept the sent run record; this forced run did not end sent';
    const h = harness({
      ...sentResult({ status: 'dry-run', dryRun: true }),
      markdown: undefined,
      kept,
    });

    await runCommand({ force: true, dryRun: true }, h.deps);

    const lines = text(h.out).trimEnd().split('\n');
    expect(lines.at(-1)).toBe(`${kept}. The week's run folder is unchanged.`);
    expect(lines).toContain('Dry run: nothing was sent.');
    expect(text(h.out)).not.toContain('digest.md');
    expect(text(h.err)).toBe('');
  });

  it('prints the reason on stdout and the error of a failed forced run on stderr', async () => {
    const kept = 'Kept the partly delivered run record; this run delivered nothing';
    const h = harness({
      record: makeRunRecord({
        runId: '2026-W43',
        status: 'failed',
        error: { step: 'write', message: 'Every writer failed' },
      }),
      exitCode: ExitCode.Failed,
      kept,
    });

    const code = await runCommand({ force: true }, h.deps);

    expect(code).toBe(1);
    expect(text(h.out)).toContain(`${kept}. The week's run folder is unchanged.`);
    expect(text(h.err)).toBe('Error (step: write): Every writer failed\n');
  });

  it('prints no keep note when the run saved its record', async () => {
    const h = harness();

    await runCommand({}, h.deps);

    expect(text(h.out)).not.toContain('Kept');
    expect(text(h.out)).not.toContain('unchanged');
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

describe('runCommand: --out', () => {
  it('overrides delivery.markdown.dir for the app it builds', async () => {
    const h = harness();

    await runCommand({ out: 'my/digests' }, h.deps);

    const built = h.buildApp.mock.calls[0]![0];
    expect(built.config.delivery.markdown.dir).toBe('my/digests');
    expect(h.loaded.config.delivery.markdown.dir).toBe('dist/digests');
  });

  it('keeps every other setting of the loaded config', async () => {
    const h = harness();

    await runCommand({ out: 'my/digests', seed: 7 }, h.deps);

    const built = h.buildApp.mock.calls[0]![0];
    expect(built.config.models.seed).toBe(7);
    expect(built.config.dataDir).toBe(DATA_DIR);
    expect(built.secrets).toBe(h.loaded.secrets);
  });

  it('uses the configured folder, dist/digests by default, without --out', async () => {
    const h = harness();

    await runCommand({}, h.deps);

    expect(h.buildApp.mock.calls[0]![0]).toBe(h.loaded);
    expect(h.loaded.config.delivery.markdown.dir).toBe('dist/digests');
  });

  it('uses the folder as given, absolute or relative', async () => {
    const h = harness();
    const absolute = join(tmpdir(), 'digests-out');

    await runCommand({ out: absolute }, h.deps);
    await runCommand({ out: './here' }, h.deps);

    expect(h.buildApp.mock.calls[0]![0].config.delivery.markdown.dir).toBe(absolute);
    expect(h.buildApp.mock.calls[1]![0].config.delivery.markdown.dir).toBe('./here');
  });

  it.each(['', '   '])(
    'rejects the blank --out "%s" before touching config or models',
    async (out) => {
      const h = harness();

      const code = await runCommand({ out }, h.deps);

      expect(code).toBe(1);
      expect(text(h.err)).toContain('--out');
      expect(h.loadConfig).not.toHaveBeenCalled();
      expect(h.buildApp).not.toHaveBeenCalled();
      expect(h.runDigest).not.toHaveBeenCalled();
    },
  );
});

describe('runCommand: local files', () => {
  let root: string;
  let digestsDir: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'run-cmd-local-'));
    digestsDir = join(root, 'digests');
    await mkdir(digestsDir);
    await writeFile(join(digestsDir, '2026-W43.md'), '# Digest\n');
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  const deliveredToMarkdown: Partial<RunRecord> = { deliveredTo: ['markdown', 'email'] };

  it('prints the Markdown and HTML paths of a sent run that wrote both', async () => {
    await writeFile(join(digestsDir, '2026-W43.html'), '<p>Digest</p>');
    const h = harness(sentResult(deliveredToMarkdown), { markdownDir: digestsDir });

    await runCommand({}, h.deps);

    expect(text(h.out)).toContain(`Markdown  ${join(digestsDir, '2026-W43.md')}\n`);
    expect(text(h.out)).toContain(`HTML      ${join(digestsDir, '2026-W43.html')}\n`);
  });

  it('prints only the Markdown path when no HTML copy was written', async () => {
    const h = harness(sentResult(deliveredToMarkdown), { markdownDir: digestsDir });

    await runCommand({}, h.deps);

    expect(text(h.out)).toContain(join(digestsDir, '2026-W43.md'));
    expect(text(h.out)).not.toMatch(/HTML/);
  });

  it('names the folder given with --out', async () => {
    const h = harness(sentResult(deliveredToMarkdown));

    await runCommand({ out: digestsDir }, h.deps);

    expect(text(h.out)).toContain(join(digestsDir, '2026-W43.md'));
  });

  it('keeps the run folder digest line next to the local files', async () => {
    const h = harness(sentResult(deliveredToMarkdown));

    await runCommand({ out: digestsDir }, h.deps);

    expect(text(h.out)).toContain(join(DATA_DIR, 'runs', '2026-W43', 'digest.md'));
    expect(text(h.out)).toContain(join(digestsDir, '2026-W43.md'));
  });

  it('prints the paths of a failed run whose Markdown channel took the digest', async () => {
    const h = harness({
      ...sentResult({ status: 'failed', deliveredTo: ['markdown'] }),
      exitCode: ExitCode.Failed,
    });

    await runCommand({ out: digestsDir }, h.deps);

    expect(text(h.out)).toContain(join(digestsDir, '2026-W43.md'));
  });

  it.each([
    ['a week with a digest sent earlier', 'skipped'],
    ['a quiet week', 'quiet'],
    ['a blocked week', 'blocked'],
  ] as const)('prints no local path for %s', async (_name, status) => {
    const h = harness({ record: makeRunRecord({ runId: '2026-W43', status }), exitCode: 0 });

    await runCommand({ out: digestsDir }, h.deps);

    expect(text(h.out)).not.toContain(digestsDir);
  });

  it('lists only the files that are there: a resumed week may have written them elsewhere', async () => {
    await rm(join(digestsDir, '2026-W43.md'));
    await writeFile(join(digestsDir, '2026-W43.html'), '<p>Digest</p>');
    const h = harness(sentResult(deliveredToMarkdown), { markdownDir: digestsDir });

    await runCommand({}, h.deps);

    expect(text(h.out)).not.toContain(digestsDir);
  });

  it('prints no local path when the Markdown channel was not reached', async () => {
    const h = harness({
      ...sentResult({ status: 'failed', deliveredTo: ['email'] }),
      exitCode: ExitCode.Failed,
    });

    await runCommand({ out: digestsDir }, h.deps);

    expect(text(h.out)).not.toContain(digestsDir);
  });
});

describe('runCommand: dry run', () => {
  const VIEW: DigestView = {
    weekId: '2026-W43',
    title: 'Week 2026-W43: 1 release, 1 needs action',
    headline: 'One thing to do.',
    groups: [
      {
        urgency: 'act-now',
        label: 'Act now',
        items: [
          {
            title: 'Gateway 2.0',
            url: 'https://example.com/gateway',
            whatChanged: 'The v1 API is removed.',
            action: 'Move off v1.',
          },
        ],
      },
    ],
  };
  const MARKDOWN = '# Week 2026-W43\n\n| Release |\n';

  /** A dry run result; `message` is what a run hands over once its core attaches the view. */
  function dryRun(message?: DigestMessage): RunResult & { message?: DigestMessage } {
    return {
      ...sentResult({ status: 'dry-run', dryRun: true }, MARKDOWN),
      ...(message && { message }),
    };
  }

  let root: string;
  let digestsDir: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'run-cmd-dry-'));
    digestsDir = join(root, 'digests');
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('writes the digest to the local folder through the Markdown channel only', async () => {
    const markdown = new CapturingDelivery('markdown');
    const email = new CapturingDelivery('email');
    const slack = new CapturingDelivery('slack');
    const h = harness(dryRun(), { deliveries: [markdown, email, slack] });

    const code = await runCommand({ dryRun: true }, h.deps);

    expect(code).toBe(0);
    expect(markdown.digests).toEqual([
      { weekId: '2026-W43', subject: 'Engineering digest 2026-W43', markdown: MARKDOWN },
    ]);
    expect(email.digests).toEqual([]);
    expect(slack.digests).toEqual([]);
    expect(email.failures).toEqual([]);
    expect(slack.failures).toEqual([]);
  });

  it('writes <week>.md into the --out folder, and no HTML while the run has no view', async () => {
    const markdownChannel = createMarkdownFileDelivery({ dir: digestsDir });
    const h = harness(dryRun(), { deliveries: [markdownChannel] });

    await runCommand({ dryRun: true, out: digestsDir }, h.deps);

    expect(await readdir(digestsDir)).toEqual(['2026-W43.md']);
    expect(await readFile(join(digestsDir, '2026-W43.md'), 'utf8')).toBe(MARKDOWN);
    expect(text(h.out)).toContain(join(digestsDir, '2026-W43.md'));
    expect(text(h.out)).not.toMatch(/HTML/);
  });

  it('writes the HTML copy too when the run hands over the message with its view', async () => {
    const message: DigestMessage = {
      weekId: '2026-W43',
      subject: 'Engineering digest 2026-W43: One thing to do.',
      markdown: MARKDOWN,
      view: VIEW,
    };
    const markdownChannel = createMarkdownFileDelivery({ dir: digestsDir });
    const h = harness(dryRun(message), { deliveries: [markdownChannel] });

    await runCommand({ dryRun: true, out: digestsDir }, h.deps);

    expect((await readdir(digestsDir)).sort()).toEqual(['2026-W43.html', '2026-W43.md']);
    expect(await readFile(join(digestsDir, '2026-W43.html'), 'utf8')).toContain('Gateway 2.0');
    expect(text(h.out)).toContain(join(digestsDir, '2026-W43.md'));
    expect(text(h.out)).toContain(join(digestsDir, '2026-W43.html'));
  });

  it('still says that nothing was sent', async () => {
    const h = harness(dryRun());

    await runCommand({ dryRun: true }, h.deps);

    expect(text(h.out)).toContain('Dry run: nothing was sent.');
  });

  it('writes nothing when the run kept the week earlier files', async () => {
    const markdown = new CapturingDelivery('markdown');
    const h = harness(
      {
        ...sentResult({ status: 'dry-run', dryRun: true }),
        markdown: undefined,
        kept: 'Kept the sent run record; this forced run did not end sent',
      },
      { deliveries: [markdown] },
    );

    await runCommand({ dryRun: true, force: true }, h.deps);

    expect(markdown.digests).toEqual([]);
    expect(text(h.out)).not.toContain('dist/digests');
  });

  it.each(['quiet', 'blocked', 'failed'] as const)(
    'writes nothing for a dry run that ended %s',
    async (status) => {
      const markdown = new CapturingDelivery('markdown');
      const h = harness(
        {
          record: makeRunRecord({ runId: '2026-W43', status, dryRun: true }),
          exitCode: ExitCode.Quiet,
          // A digest is there, so only the status stops the write.
          markdown: MARKDOWN,
        },
        { deliveries: [markdown] },
      );

      await runCommand({ dryRun: true }, h.deps);

      expect(markdown.digests).toEqual([]);
    },
  );

  it('does not write a second copy for a real run: the run delivered it already', async () => {
    const markdown = new CapturingDelivery('markdown');
    const h = harness(sentResult({ deliveredTo: ['markdown'] }), { deliveries: [markdown] });

    await runCommand({}, h.deps);

    expect(markdown.digests).toEqual([]);
  });

  it('writes nothing, and does not fail, when the app has no Markdown channel', async () => {
    const h = harness(dryRun(), { deliveries: [new CapturingDelivery('email')] });

    const code = await runCommand({ dryRun: true }, h.deps);

    expect(code).toBe(0);
    expect(text(h.err)).toBe('');
    expect(text(h.out)).not.toContain('dist/digests');
  });

  it('reports a failed local write on stderr, exits 1 and prints no local path', async () => {
    const markdown = new CapturingDelivery('markdown');
    markdown.failWith = new Error('EACCES: permission denied, mkdir');
    const h = harness(dryRun(), { deliveries: [markdown] });

    const code = await runCommand({ dryRun: true, out: '/nowhere' }, h.deps);

    expect(code).toBe(1);
    expect(text(h.err)).toContain('/nowhere');
    expect(text(h.err)).toContain('EACCES: permission denied, mkdir');
    expect(text(h.out)).toMatch(/Status\s+dry-run/);
    expect(text(h.out)).not.toContain('2026-W43.md');
    expect(h.close).toHaveBeenCalledOnce();
  });

  it('redacts secrets from a failed local write', async () => {
    const markdown = new CapturingDelivery('markdown');
    markdown.failWith = new Error('cannot write hunter2-smtp');
    const h = harness(dryRun(), { deliveries: [markdown] });
    h.loadConfig.mockResolvedValue({ ...h.loaded, secrets: { SMTP_PASSWORD: 'hunter2-smtp' } });

    await runCommand({ dryRun: true }, h.deps);

    expect(text(h.err)).toContain('cannot write [redacted]');
    expect(text(h.err)).not.toContain('hunter2-smtp');
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
