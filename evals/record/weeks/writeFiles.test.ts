import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { formatLikeRepo, toJson, writeIfAbsent } from './writeFiles';

let dir = '';
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'record-write-'));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('writeIfAbsent', () => {
  it('creates the file and says so', async () => {
    const path = join(dir, 'labels.json');

    expect(await writeIfAbsent(path, 'first')).toBe(true);
    expect(await readFile(path, 'utf8')).toBe('first');
  });

  it('leaves an existing file alone and says so', async () => {
    const path = join(dir, 'labels.json');
    await writeFile(path, 'by hand');

    expect(await writeIfAbsent(path, 'template')).toBe(false);
    expect(await readFile(path, 'utf8')).toBe('by hand');
  });

  it('leaves an existing empty file alone too', async () => {
    const path = join(dir, 'labels.json');
    await writeFile(path, '');

    expect(await writeIfAbsent(path, 'template')).toBe(false);
    expect(await readFile(path, 'utf8')).toBe('');
  });

  it('lets any other error through', async () => {
    await expect(writeIfAbsent(join(dir, 'missing-folder', 'labels.json'), 'x')).rejects.toThrow(
      /ENOENT/,
    );
  });
});

describe('toJson', () => {
  it('writes two-space JSON that ends with a newline', async () => {
    expect(await toJson(join(dir, 'a.json'), { a: [1, 2], b: 'x' })).toBe(
      '{\n  "a": [1, 2],\n  "b": "x"\n}\n',
    );
  });

  it('writes the labels template one key per line', async () => {
    const text = await toJson(join(dir, 'labels.json'), {
      mustInclude: [],
      mustExclude: [],
      notes: '',
    });

    expect(text).toBe('{\n  "mustInclude": [],\n  "mustExclude": [],\n  "notes": ""\n}\n');
  });
});

describe('formatLikeRepo', () => {
  it('uses the prettier config found next to the path', async () => {
    await writeFile(join(dir, '.prettierrc.json'), '{ "tabWidth": 4 }');

    const text = await formatLikeRepo(join(dir, 'a.json'), JSON.stringify([{ id: 'x' }], null, 2));

    expect(text).toBe('[\n    {\n        "id": "x"\n    }\n]\n');
  });

  it('formats Markdown by the extension of the path', async () => {
    const text = await formatLikeRepo(join(dir, 'candidates.md'), '# Title\n\n\n\ntext   here\n');

    expect(text).toBe('# Title\n\ntext here\n');
  });
});
