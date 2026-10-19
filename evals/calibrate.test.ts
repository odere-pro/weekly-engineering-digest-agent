import { mkdtemp, readFile, rm, writeFile, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { runCli } from './calibrate';
import { CalibrationSchema } from '../src/process/calibration';
import { liftingCapture, rawCapture, weekCases } from './calibration/__fixtures__/calibrationKit';
import type { RawCapture } from './thresholds/capture/schemas';

const exists = (path: string) =>
  access(path).then(
    () => true,
    () => false,
  );

describe('runCli', () => {
  const dirs: string[] = [];
  afterEach(async () => {
    vi.restoreAllMocks();
    await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
  });

  async function kit(args: string[], capture: RawCapture = rawCapture()) {
    const dir = await mkdtemp(join(tmpdir(), 'calibrate-'));
    dirs.push(dir);
    const rawPath = join(dir, 'raw.json');
    await writeFile(rawPath, JSON.stringify(capture));
    const out: string[] = [];
    const err: string[] = [];
    const code = await runCli([rawPath, ...args.map((a) => a.replace('$DIR', dir))], {
      casesDir: dir,
      loadCases: () => Promise.resolve(weekCases()),
      stdout: (t) => out.push(t),
      stderr: (t) => err.push(t),
    });
    return { dir, code, out: out.join(''), err: err.join('') };
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
    expect(await exists(join(dir, 'c.json'))).toBe(kept);
    if (kept)
      expect(
        CalibrationSchema.safeParse(JSON.parse(await readFile(join(dir, 'c.json'), 'utf8')))
          .success,
      ).toBe(true);
  });

  it('does not write without --write', async () => {
    const { dir, code } = await kit([]);
    expect(code).toBe(0);
    await expect(access(join(dir, 'calibration', 'light.json'))).rejects.toThrow();
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

    it('writes to <casesDir>/calibration/<profile>.json without --out', async () => {
      const { dir, out } = await kit(['--holdout', '2026-W40', '--write'], liftingCapture());

      expect(out).toContain(`wrote ${join(dir, 'calibration', 'light.json')}\n`);
      expect(await exists(join(dir, 'calibration', 'light.json'))).toBe(true);
    });

    it('writes nothing without --write, though the verdict is keep', async () => {
      const { dir, out } = await kit(['--holdout', '2026-W40'], liftingCapture());

      expect(out).toContain('verdict: keep');
      expect(out).not.toContain('wrote');
      expect(await exists(join(dir, 'calibration'))).toBe(false);
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

    const { dir, code, out } = await kit(['--holdout', '2026-W40', '--write'], capture);

    expect(code).toBe(0);
    expect(out).toContain('verdict: drop (recall did not rise or leaks rose)');
    expect(out).not.toContain('wrote');
    expect(await exists(join(dir, 'calibration'))).toBe(false);
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
