import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DigestError } from '../../../src/shared/errors';
import { folderNames, readParsed } from './readFiles';

let root = '';
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'recording-files-'));
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe('readParsed', () => {
  const Schema = z.object({ name: z.string() });

  it('returns the JSON file as the schema parsed it', async () => {
    await writeFile(join(root, 'a.json'), '{"name":"feed"}');

    expect(await readParsed(join(root, 'a.json'), Schema)).toEqual({ name: 'feed' });
  });

  it('names the file when it cannot be read', async () => {
    const path = join(root, 'missing.json');

    await expect(readParsed(path, Schema)).rejects.toThrow(`Cannot read ${path}`);
    await expect(readParsed(path, Schema)).rejects.toBeInstanceOf(DigestError);
  });

  it('names the file when it is not JSON', async () => {
    const path = join(root, 'bad.json');
    await writeFile(path, '{ not json');

    await expect(readParsed(path, Schema)).rejects.toThrow(`Cannot read ${path}`);
  });

  it('names the file and the field when the JSON does not match the schema', async () => {
    const path = join(root, 'wrong.json');
    await writeFile(path, '{"name":3}');

    await expect(readParsed(path, Schema)).rejects.toThrow(
      new RegExp(`${path} does not match its schema:[\\s\\S]*name`),
    );
  });
});

describe('folderNames', () => {
  it('lists the sub-folders in name order and leaves files out', async () => {
    await mkdir(join(root, 'b'));
    await mkdir(join(root, 'a'));
    await writeFile(join(root, 'note.txt'), 'not a folder');

    expect(await folderNames(root)).toEqual(['a', 'b']);
  });

  it('is empty when the folder does not exist', async () => {
    expect(await folderNames(join(root, 'missing'))).toEqual([]);
  });

  it('fails, naming the path, when it is not a folder', async () => {
    const file = join(root, 'plain.txt');
    await writeFile(file, 'x');

    await expect(folderNames(file)).rejects.toThrow(`Cannot read ${file}`);
  });
});
