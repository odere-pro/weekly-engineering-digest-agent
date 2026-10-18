import { mkdtemp, readFile, readdir, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  checkpointDir,
  createCheckpoints,
  fingerprintOf,
  type CheckpointCodec,
} from './checkpoint';

const codec: CheckpointCodec<{ n: number }> = {
  encode: (value) => value,
  decode: (saved) =>
    typeof saved === 'object' && saved !== null && 'n' in saved && typeof saved.n === 'number'
      ? { n: saved.n }
      : undefined,
};

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'eval-checkpoint-'));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

function checkpoints(options: { fingerprint?: string; resume?: boolean; warn?: () => void } = {}) {
  return createCheckpoints({
    dir: join(dir, 'day'),
    fingerprint: options.fingerprint ?? 'fp-1',
    resume: options.resume ?? true,
    warn: options.warn ?? (() => undefined),
  });
}

describe('createCheckpoints', () => {
  it('computes and saves a result, then reuses it on resume', async () => {
    const compute = vi.fn(() => Promise.resolve({ n: 1 }));
    await checkpoints().resume('light.W40.run1', compute, codec);
    const again = await checkpoints().resume('light.W40.run1', compute, codec);
    expect(again).toEqual({ n: 1 });
    expect(compute).toHaveBeenCalledTimes(1);
  });

  it('computes again when the fingerprint differs (config or git sha changed)', async () => {
    const compute = vi.fn(() => Promise.resolve({ n: 2 }));
    await checkpoints({ fingerprint: 'fp-1' }).resume('a', compute, codec);
    await checkpoints({ fingerprint: 'fp-2' }).resume('a', compute, codec);
    expect(compute).toHaveBeenCalledTimes(2);
    const saved = JSON.parse(await readFile(join(dir, 'day', 'a.json'), 'utf8')) as {
      fingerprint: string;
    };
    expect(saved.fingerprint).toBe('fp-2');
  });

  it('writes checkpoints but does not read them when resume is off', async () => {
    const compute = vi.fn(() => Promise.resolve({ n: 3 }));
    await checkpoints({ resume: false }).resume('a', compute, codec);
    await checkpoints({ resume: false }).resume('a', compute, codec);
    expect(compute).toHaveBeenCalledTimes(2);
    expect(await readdir(join(dir, 'day'))).toEqual(['a.json']);
  });

  it.each([
    ['not JSON', 'oops'],
    ['not a checkpoint', '{"x":1}'],
    ['data the codec rejects', '{"fingerprint":"fp-1","data":{"n":"x"}}'],
  ])('computes again when the saved file is %s', async (_name, content) => {
    await mkdir(join(dir, 'day'), { recursive: true });
    await writeFile(join(dir, 'day', 'a.json'), content);
    const compute = vi.fn(() => Promise.resolve({ n: 4 }));
    expect(await checkpoints().resume('a', compute, codec)).toEqual({ n: 4 });
    expect(compute).toHaveBeenCalledTimes(1);
  });

  it('warns and still returns the result when a checkpoint cannot be saved', async () => {
    await writeFile(join(dir, 'day'), 'a file where the folder should be');
    const warn = vi.fn();
    const value = await checkpoints({ warn }).resume('a', () => Promise.resolve({ n: 5 }), codec);
    expect(value).toEqual({ n: 5 });
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('could not save a checkpoint'));
  });

  it('keeps a name inside the folder', async () => {
    await checkpoints().resume('../escape', () => Promise.resolve({ n: 6 }), codec);
    expect(await readdir(join(dir, 'day'))).toEqual(['.._escape.json']);
  });
});

describe('fingerprintOf', () => {
  it('is the same for the same parts and differs when one changes', () => {
    expect(fingerprintOf({ a: 1, b: 'x' })).toBe(fingerprintOf({ a: 1, b: 'x' }));
    expect(fingerprintOf({ a: 1, b: 'x' })).not.toBe(fingerprintOf({ a: 2, b: 'x' }));
  });
});

describe('checkpointDir', () => {
  it("is today's folder when not resuming", async () => {
    await mkdir(join(dir, '2026-10-17'));
    expect(await checkpointDir(dir, '2026-10-19', false)).toBe(join(dir, '2026-10-19'));
  });

  it('is the newest date folder when resuming', async () => {
    await mkdir(join(dir, '2026-10-16'));
    await mkdir(join(dir, '2026-10-17'));
    await mkdir(join(dir, 'notes'));
    expect(await checkpointDir(dir, '2026-10-19', true)).toBe(join(dir, '2026-10-17'));
  });

  it("is today's folder when resuming and none exists yet", async () => {
    expect(await checkpointDir(join(dir, 'missing'), '2026-10-19', true)).toBe(
      join(dir, 'missing', '2026-10-19'),
    );
  });
});
