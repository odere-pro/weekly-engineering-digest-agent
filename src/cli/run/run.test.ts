import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { ExitCode } from '../../domain/schemas';
import { DigestError } from '../../shared/errors';
import { harness, sentResult, text } from './__fixtures__/runHarness';
import { runCommand } from './run';

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

describe('runCommand: default dependencies', () => {
  it('reports a missing config on the process stderr', async () => {
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);

    const code = await runCommand({ config: join(tmpdir(), 'digest-no-such-dir', 'x.json') });

    expect(code).toBe(1);
    expect(stderr).toHaveBeenCalledWith(expect.stringContaining('digest init'));
  });
});
