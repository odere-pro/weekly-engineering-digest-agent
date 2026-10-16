import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createMarkdownFileDelivery } from '../../../src/adapters/delivery/markdownFile.js';
import { writeFileAtomic } from '../../../src/adapters/store/atomicFile.js';

// Delegates to the real writer, so tests can assert the digest goes through the atomic path.
vi.mock('../../../src/adapters/store/atomicFile.js', async (importOriginal) => {
  const actual = await importOriginal<{ writeFileAtomic: typeof writeFileAtomic }>();
  return { ...actual, writeFileAtomic: vi.fn(actual.writeFileAtomic) };
});

const message = {
  weekId: '2026-W42',
  subject: 'Engineering digest 2026-W42',
  markdown: '# Digest\n\n- [Ollama 0.9](https://example.com/a)\n',
};

let root: string;
let dir: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'delivery-md-'));
  dir = join(root, 'digests');
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe('createMarkdownFileDelivery', () => {
  it('identifies as the markdown channel', () => {
    expect(createMarkdownFileDelivery({ dir }).id).toBe('markdown');
  });

  describe('sendDigest', () => {
    it('writes <dir>/<weekId>.md with the markdown and creates the folder', async () => {
      await createMarkdownFileDelivery({ dir }).sendDigest(message);

      expect(await readFile(join(dir, '2026-W42.md'), 'utf8')).toBe(message.markdown);
    });

    it('writes through the atomic temp-file-then-rename writer', async () => {
      await createMarkdownFileDelivery({ dir }).sendDigest(message);

      expect(writeFileAtomic).toHaveBeenCalledWith(join(dir, '2026-W42.md'), message.markdown);
    });

    it('replaces an earlier digest for the same week and leaves no temp files behind', async () => {
      const delivery = createMarkdownFileDelivery({ dir });
      await delivery.sendDigest(message);
      await delivery.sendDigest({ ...message, markdown: '# Second run\n' });

      expect(await readFile(join(dir, '2026-W42.md'), 'utf8')).toBe('# Second run\n');
      expect(await readdir(dir)).toEqual(['2026-W42.md']);
    });

    it.each([
      '../evil',
      'a/b',
      'a\\b',
      '..',
      '.x',
      '',
      '2026-W42\n',
      '2026-W42.failed',
      '2026-W54',
      'latest',
    ])('rejects the week id %j and writes nothing', async (weekId) => {
      const delivery = createMarkdownFileDelivery({ dir });

      await expect(delivery.sendDigest({ ...message, weekId })).rejects.toThrow(/week id/i);
      await expect(delivery.sendFailure({ weekId, message: 'boom' })).rejects.toThrow(/week id/i);
      expect(await readdir(root)).toEqual([]);
    });

    it('rejects when the folder cannot be created', async () => {
      const blocker = join(root, 'blocker');
      await writeFile(blocker, 'a file, not a folder');

      await expect(
        createMarkdownFileDelivery({ dir: join(blocker, 'digests') }).sendDigest(message),
      ).rejects.toThrow();
    });
  });

  describe('sendFailure', () => {
    it('writes <dir>/<weekId>.failed.md with the step and the message', async () => {
      await createMarkdownFileDelivery({ dir }).sendFailure({
        weekId: '2026-W42',
        step: 'write',
        message: 'Writer panel returned no draft',
      });

      const note = await readFile(join(dir, '2026-W42.failed.md'), 'utf8');
      expect(note).toContain('2026-W42');
      expect(note).toContain('write');
      expect(note).toContain('Writer panel returned no draft');
    });

    it('omits the step line when no step is known', async () => {
      await createMarkdownFileDelivery({ dir }).sendFailure({
        weekId: '2026-W42',
        message: 'Ollama is not reachable',
      });

      const note = await readFile(join(dir, '2026-W42.failed.md'), 'utf8');
      expect(note).toContain('Ollama is not reachable');
      expect(note).not.toMatch(/step/i);
    });

    it('does not touch the digest file of the same week', async () => {
      const delivery = createMarkdownFileDelivery({ dir });
      await delivery.sendDigest(message);
      await delivery.sendFailure({ weekId: '2026-W42', message: 'later failure' });

      expect(await readFile(join(dir, '2026-W42.md'), 'utf8')).toBe(message.markdown);
      expect((await readdir(dir)).sort()).toEqual(['2026-W42.failed.md', '2026-W42.md']);
    });
  });
});
