import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { fixedClock } from '../../../src/shared/clock';
import { ATTACKS, policy, rawCapture, repeat } from '../__fixtures__/records';
import { TuningResultSchema } from '../result/schema';
import { localDate } from './files';
import type { CliIo } from './io';
import { sweepCommand } from './sweepCommand';

let dir: string;
let out: string[];

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'thresholds-sweep-'));
  out = [];
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const io = (): CliIo => ({
  casesDir: '/unused',
  outDir: dir,
  clock: fixedClock('2026-10-17T10:00:00Z'),
  stdout: (text) => out.push(text),
  stderr: () => undefined,
  openCapture: () => Promise.reject(new Error('sweep opens no session')),
  loadEvalSet: () => Promise.reject(new Error('sweep loads no cases')),
});

async function saved(raw = rawCapture()): Promise<string> {
  const path = join(dir, 'raw.json');
  await writeFile(path, JSON.stringify(raw));
  return path;
}

describe('sweepCommand', () => {
  it('sweeps a raw capture into <date>-<profile>.json and prints the proposal', async () => {
    const code = await sweepCommand(await saved(), undefined, io());
    expect(code).toBe(0);
    const resultPath = join(dir, `${localDate(rawCapture().capturedAt)}-light.json`);
    const result = TuningResultSchema.parse(JSON.parse(await readFile(resultPath, 'utf8')));
    expect(result.proposed.guardFlag).toBe(0.55);
    expect(out.join('')).toContain('guardFlag');
    expect(out.join('').endsWith(`\nSaved ${resultPath}\n`)).toBe(true);
  });

  it('reads the held-out weeks from the holdout list and prints both sides', async () => {
    const weeks = ['2026-W38', '2026-W39', '2026-W40'];
    const clean = weeks.flatMap((week) =>
      repeat(20, () => ({ ...policy('clean', 0.01), from: week })),
    );
    const path = await saved(rawCapture({ inputGuards: [...clean, ...ATTACKS] }));
    expect(await sweepCommand(path, ['2026-W39', '2026-W40'], io())).toBe(0);
    const text = out.join('');
    expect(text).toMatch(/train\s+holdout\s+gap/);
    expect(text).toContain('held out:');
    expect(text).toContain('2026-W39, 2026-W40');
  });

  it('fails for a held-out week the capture does not have', async () => {
    await expect(sweepCommand(await saved(), ['2026-W01'], io())).rejects.toThrow(
      'no week 2026-W01',
    );
  });

  it('fails, naming the file, when the raw capture is missing or malformed', async () => {
    await expect(sweepCommand(join(dir, 'none.json'), undefined, io())).rejects.toThrow(
      'Cannot read',
    );
    const path = join(dir, 'bad.json');
    await writeFile(path, JSON.stringify({ profile: 'light' }));
    await expect(sweepCommand(path, undefined, io())).rejects.toThrow(
      `${path} is not a raw capture`,
    );
  });
});
