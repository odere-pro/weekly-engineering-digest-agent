import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { runCli } from './calibrate';
import { loadConfig, type LoadedConfig } from '../src/config/load';
import { CalibrationSchema } from '../src/process/calibration';
import { DigestError } from '../src/shared/errors';
import { pathExists } from '../src/shared/fsErrors';
import { makeConfig } from '../test/builders';
import { liftingCapture, rawCapture, weekCases } from './calibration/__fixtures__/calibrationKit';
import type { RawCapture } from './thresholds/capture/schemas';

// The real loader reads digest.config.json and .env from the working folder: replaced here, so
// the default wiring is tested without a file. Every other test injects `loadDataDir`.
vi.mock('../src/config/load', () => ({ loadConfig: vi.fn() }));

describe('runCli', () => {
  const dirs: string[] = [];
  afterEach(async () => {
    vi.restoreAllMocks();
    vi.mocked(loadConfig).mockReset();
    await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
  });

  async function kit(
    args: string[],
    capture: RawCapture = rawCapture(),
    loadDataDir?: () => Promise<string>,
  ) {
    const dir = await mkdtemp(join(tmpdir(), 'calibrate-'));
    dirs.push(dir);
    const casesDir = join(dir, 'evals');
    const dataDir = join(dir, 'data');
    const rawPath = join(dir, 'raw.json');
    await writeFile(rawPath, JSON.stringify(capture));
    const out: string[] = [];
    const err: string[] = [];
    const code = await runCli([rawPath, ...args.map((a) => a.replace('$DIR', dir))], {
      casesDir,
      loadDataDir: loadDataDir ?? (() => Promise.resolve(dataDir)),
      loadCases: () => Promise.resolve(weekCases()),
      stdout: (t) => out.push(t),
      stderr: (t) => err.push(t),
    });
    return { dir, casesDir, dataDir, code, out: out.join(''), err: err.join('') };
  }

  it('prints usage without arguments', async () => {
    const err: string[] = [];
    const code = await runCli([], { stderr: (t) => err.push(t) });
    expect(code).toBe(2);
    expect(err.join('')).toMatch(/Usage/);
  });

  it('exits 2 on an unknown option', async () => {
    const err: string[] = [];
    expect(await runCli(['--bogus'], { stderr: (t) => err.push(t) })).toBe(2);
  });

  it('prints the holdout table and writes the file only when it is kept', async () => {
    const { dir, code, out } = await kit([
      '--holdout',
      '2026-W40',
      '--write',
      '--out',
      '$DIR/c.json',
    ]);
    expect(code).toBe(0);
    expect(out).toContain('holdout recall');
    const kept = out.includes('verdict: keep');
    expect(await pathExists(join(dir, 'c.json'))).toBe(kept);
    if (kept)
      expect(
        CalibrationSchema.safeParse(JSON.parse(await readFile(join(dir, 'c.json'), 'utf8')))
          .success,
      ).toBe(true);
  });

  it('does not write without --write', async () => {
    const { dir, dataDir, code } = await kit([]);
    expect(code).toBe(0);
    expect(await pathExists(join(dataDir, 'eval'))).toBe(false);
    expect(await pathExists(join(dir, 'evals', 'calibration'))).toBe(false);
  });

  it('exits 1 for a bad capture or a bad holdout week', async () => {
    expect((await kit(['--holdout', 'nope'])).code).toBe(1);
    const err: string[] = [];
    expect(await runCli(['/no/such/file.json'], { stderr: (t) => err.push(t) })).toBe(1);
    expect(err.join('')).toContain('calibrate failed');
  });

  describe('when the file lifts recall', () => {
    it('keeps it and writes it to --out', async () => {
      const { dir, code, out } = await kit(
        ['--holdout', '2026-W40', '--write', '--out', '$DIR/nested/c.json'],
        liftingCapture(),
      );

      expect(code).toBe(0);
      expect(out).toContain('verdict: keep');
      expect(out).toContain(`wrote ${join(dir, 'nested', 'c.json')}\n`);
      const written: unknown = JSON.parse(await readFile(join(dir, 'nested', 'c.json'), 'utf8'));
      expect(CalibrationSchema.parse(written)).toMatchObject({ version: 1, profile: 'light' });
    });

    it('writes to <dataDir>/eval/calibration/<profile>.json without --out', async () => {
      const { dataDir, code, out } = await kit(
        ['--holdout', '2026-W40', '--write'],
        liftingCapture(),
      );
      const file = join(dataDir, 'eval', 'calibration', 'light.json');

      expect(code).toBe(0);
      expect(out).toContain(`wrote ${file}\n`);
      const written: unknown = JSON.parse(await readFile(file, 'utf8'));
      expect(CalibrationSchema.parse(written)).toMatchObject({ version: 1, profile: 'light' });
    });

    it('never writes the default file into the evals folder', async () => {
      const { casesDir, code } = await kit(['--holdout', '2026-W40', '--write'], liftingCapture());

      expect(code).toBe(0);
      expect(await pathExists(join(casesDir, 'calibration'))).toBe(false);
    });

    it('lets --out win and never asks for the data folder', async () => {
      const loadDataDir = vi.fn(() => Promise.resolve('unused'));
      const { dir, dataDir, code } = await kit(
        ['--holdout', '2026-W40', '--write', '--out', '$DIR/chosen.json'],
        liftingCapture(),
        loadDataDir,
      );

      expect(code).toBe(0);
      expect(loadDataDir).not.toHaveBeenCalled();
      expect(await pathExists(join(dir, 'chosen.json'))).toBe(true);
      expect(await pathExists(join(dataDir, 'eval'))).toBe(false);
    });

    it('fails with a hint to pass --out when the data folder cannot be read', async () => {
      const loadDataDir = () =>
        Promise.reject(
          new DigestError('No digest.config.json found at /x. Run "digest init" first.'),
        );
      const { dir, code, err } = await kit(
        ['--holdout', '2026-W40', '--write'],
        liftingCapture(),
        loadDataDir,
      );

      expect(code).toBe(1);
      expect(err).toContain('calibrate failed:');
      expect(err).toContain('No digest.config.json found at /x');
      expect(err).toContain('--out <file>');
      expect(await pathExists(join(dir, 'evals', 'calibration'))).toBe(false);
    });

    it('takes the data folder from digest.config.json by default', async () => {
      const dir = await mkdtemp(join(tmpdir(), 'calibrate-'));
      dirs.push(dir);
      const rawPath = join(dir, 'raw.json');
      await writeFile(rawPath, JSON.stringify(liftingCapture()));
      vi.mocked(loadConfig).mockResolvedValue({
        config: makeConfig({ dataDir: join(dir, 'configured') }),
      } as unknown as LoadedConfig);
      const out: string[] = [];

      const code = await runCli([rawPath, '--holdout', '2026-W40', '--write'], {
        casesDir: join(dir, 'evals'),
        loadCases: () => Promise.resolve(weekCases()),
        stdout: (t) => out.push(t),
      });

      expect(code).toBe(0);
      expect(loadConfig).toHaveBeenCalledTimes(1);
      expect(loadConfig).toHaveBeenCalledWith();
      expect(await pathExists(join(dir, 'configured', 'eval', 'calibration', 'light.json'))).toBe(
        true,
      );
    });

    it('writes nothing without --write, though the verdict is keep', async () => {
      const loadDataDir = vi.fn(() => Promise.resolve('unused'));
      const { dataDir, out } = await kit(['--holdout', '2026-W40'], liftingCapture(), loadDataDir);

      expect(out).toContain('verdict: keep');
      expect(out).not.toContain('wrote');
      expect(loadDataDir).not.toHaveBeenCalled();
      expect(await pathExists(join(dataDir, 'eval'))).toBe(false);
    });
  });

  it('drops the file and writes nothing when recall does not rise', async () => {
    // Every item scores 2.5 and passes with or without the file: nothing to gain.
    const lifting = liftingCapture();
    const capture = {
      ...lifting,
      weekItems: lifting.weekItems.map((record) => ({
        ...record,
        result: { ...record.result, relevance: 2.5 },
      })),
    } as RawCapture;

    const loadDataDir = vi.fn(() => Promise.resolve('unused'));
    const { dataDir, code, out } = await kit(
      ['--holdout', '2026-W40', '--write'],
      capture,
      loadDataDir,
    );

    expect(code).toBe(0);
    expect(out).toContain('verdict: drop (recall did not rise or leaks rose)');
    expect(out).not.toContain('wrote');
    expect(loadDataDir).not.toHaveBeenCalled();
    expect(await pathExists(join(dataDir, 'eval'))).toBe(false);
  });

  it('prints to the process streams when no stream is given', async () => {
    const stdout = vi.spyOn(process.stdout, 'write').mockReturnValue(true);
    const stderr = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
    const dir = await mkdtemp(join(tmpdir(), 'calibrate-'));
    dirs.push(dir);
    const rawPath = join(dir, 'raw.json');
    await writeFile(rawPath, JSON.stringify(liftingCapture()));

    const done = await runCli([rawPath, '--holdout', '2026-W40'], {
      casesDir: dir,
      loadCases: () => Promise.resolve(weekCases()),
    });
    const usage = await runCli([]);

    expect(done).toBe(0);
    expect(usage).toBe(2);
    expect(stdout.mock.calls.flat().join('')).toContain('verdict: keep');
    expect(stderr.mock.calls.flat().join('')).toContain('Usage: tsx evals/calibrate.ts');
  });
});
