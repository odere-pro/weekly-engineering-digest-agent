import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { DigestError } from '../../src/shared/errors';
import { useCasesDir, writeJson } from '../evalKit';
import { listNames, readJson, requireFolder, requireJson } from './jsonFiles';

const root = useCasesDir();
const PointSchema = z.object({ x: z.number() });

describe('readJson', () => {
  it('returns the parsed value', async () => {
    await writeJson(root(), 'p.json', { x: 1 });

    expect(await readJson(join(root(), 'p.json'), PointSchema)).toEqual({ x: 1 });
  });

  it('returns undefined when the file does not exist', async () => {
    expect(await readJson(join(root(), 'none.json'), PointSchema)).toBeUndefined();
  });

  it('names the file when it is not valid JSON', async () => {
    await writeFile(join(root(), 'p.json'), '{ nope');

    await expect(readJson(join(root(), 'p.json'), PointSchema)).rejects.toThrow(
      /p\.json is not valid JSON/,
    );
  });

  it('names the file and the field when the schema does not match', async () => {
    await writeJson(root(), 'p.json', { x: 'one' });

    await expect(readJson(join(root(), 'p.json'), PointSchema)).rejects.toThrow(
      /p\.json does not match its schema:[\s\S]*x/,
    );
  });

  it('names the path when the file cannot be read', async () => {
    // A folder where a file is expected: readFile fails with EISDIR, not ENOENT.
    const error = await readJson(root(), PointSchema).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(DigestError);
    expect((error as DigestError).message).toContain(`Cannot read ${root()}`);
  });
});

describe('requireJson', () => {
  it('returns the value of a file that is there', async () => {
    await writeJson(root(), 'p.json', { x: 2 });

    expect(await requireJson(join(root(), 'p.json'), PointSchema)).toEqual({ x: 2 });
  });

  it('says the file is missing when it is not there', async () => {
    await expect(requireJson(join(root(), 'p.json'), PointSchema)).rejects.toThrow(
      /p\.json is missing/,
    );
  });
});

describe('requireFolder', () => {
  it('passes for a folder that exists', async () => {
    await expect(requireFolder(root())).resolves.toBeUndefined();
  });

  it('keeps the plain message for a missing folder', async () => {
    const path = join(root(), 'nope');

    await expect(requireFolder(path)).rejects.toThrow(
      new DigestError(`Eval folder ${path}: not found`),
    );
  });

  it('adds the hint to the message of a missing folder', async () => {
    const path = join(root(), 'nope');

    await expect(requireFolder(path, 'Use a clone.')).rejects.toThrow(
      `Eval folder ${path}: not found. Use a clone.`,
    );
  });

  it('gives the system reason, without the hint, when the folder cannot be checked', async () => {
    await writeFile(join(root(), 'file'), 'x');
    // A path below a file: stat fails with ENOTDIR, which is not "not found".
    const error = await requireFolder(join(root(), 'file', 'below'), 'Use a clone.').catch(
      (caught: unknown) => caught,
    );

    expect(error).toBeInstanceOf(DigestError);
    expect((error as DigestError).message).not.toContain('Use a clone.');
    expect((error as DigestError).message).not.toContain('not found');
    expect((error as DigestError).message).toContain('ENOTDIR');
  });
});

describe('listNames', () => {
  it('lists names sorted', async () => {
    await writeJson(root(), 'b.json', {});
    await writeJson(root(), 'a.json', {});

    expect(await listNames(root())).toEqual(['a.json', 'b.json']);
  });

  it('is empty for a folder that does not exist', async () => {
    expect(await listNames(join(root(), 'nope'))).toEqual([]);
  });

  it('names the folder when it cannot be read', async () => {
    await writeFile(join(root(), 'file'), 'x');

    await expect(listNames(join(root(), 'file'))).rejects.toThrow(/Cannot read .*file/);
  });
});
