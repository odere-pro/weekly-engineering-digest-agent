import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { rawCapture } from '../__fixtures__/records';
import { assertNew, localDate, readRaw, writeJson } from './files';

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'thresholds-files-'));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('localDate', () => {
  it('formats an instant as the local calendar date', () => {
    const at = new Date(2026, 9, 17, 1, 30);
    expect(localDate(at.toISOString())).toBe('2026-10-17');
  });

  it('pads the month and the day', () => {
    const at = new Date(2026, 0, 5, 12, 0);
    expect(localDate(at.toISOString())).toBe('2026-01-05');
  });
});

describe('writeJson', () => {
  it('writes JSON through prettier, ends it with a newline and makes the folder', async () => {
    const path = join(dir, 'raw', 'out.json');
    await writeJson(path, { a: [1, 2], b: 'x' });
    const text = await readFile(path, 'utf8');
    expect(JSON.parse(text)).toEqual({ a: [1, 2], b: 'x' });
    expect(text.endsWith('\n')).toBe(true);
  });

  it('replaces an existing file by default', async () => {
    const path = join(dir, 'out.json');
    await writeJson(path, { n: 1 });
    await writeJson(path, { n: 2 });
    expect(JSON.parse(await readFile(path, 'utf8'))).toEqual({ n: 2 });
  });

  it('never replaces an existing file when overwrite is false', async () => {
    const path = join(dir, 'out.json');
    await writeJson(path, { n: 1 }, false);
    await expect(writeJson(path, { n: 2 }, false)).rejects.toThrow(/EEXIST/);
    expect(JSON.parse(await readFile(path, 'utf8'))).toEqual({ n: 1 });
  });
});

describe('assertNew', () => {
  it('accepts a path with no file', async () => {
    await expect(assertNew(join(dir, 'none.json'))).resolves.toBeUndefined();
  });

  it('names the file and the --force flag when it exists', async () => {
    const path = join(dir, 'there.json');
    await writeFile(path, '{}');
    await expect(assertNew(path)).rejects.toThrow(`${path} exists; pass --force to replace it`);
  });
});

describe('readRaw', () => {
  it('reads a raw capture', async () => {
    const path = join(dir, 'raw.json');
    await writeFile(path, JSON.stringify(rawCapture()));
    expect(await readRaw(path)).toEqual(rawCapture());
  });

  it('names the file when it cannot be read', async () => {
    const path = join(dir, 'missing.json');
    await expect(readRaw(path)).rejects.toThrow(`Cannot read ${path}`);
  });

  it('names the file when it is not JSON', async () => {
    const path = join(dir, 'bad.json');
    await writeFile(path, '{ not json');
    await expect(readRaw(path)).rejects.toThrow(`Cannot read ${path}`);
  });

  it('names the file and what is wrong when it does not match the schema', async () => {
    const path = join(dir, 'wrong.json');
    await writeFile(path, JSON.stringify({ profile: 'light' }));
    await expect(readRaw(path)).rejects.toThrow(`${path} is not a raw capture`);
  });
});
