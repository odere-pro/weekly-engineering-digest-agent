import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createMarkdownFileDelivery, markdownFileOptions, markdownFolder } from './markdownFile';
import { writeFileAtomic } from '../../shared/atomicFile';

// Delegates to the real writer, so tests can assert the digest goes through the atomic path.
vi.mock('../../shared/atomicFile', async (importOriginal) => {
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

describe('the folder a week goes to', () => {
  it("is the week's digest folder below the data folder when no dir is set", async () => {
    const dataDir = join(root, 'dist');
    await createMarkdownFileDelivery({ dataDir }).sendDigest(message);

    // 2026-10-12 is the Monday of 2026-W42.
    const weekDir = join(dataDir, '2026-10-12', 'digest');
    expect(await readFile(join(weekDir, '2026-W42.md'), 'utf8')).toBe(message.markdown);
  });

  it('puts a failure note in the same week folder', async () => {
    const dataDir = join(root, 'dist');
    await createMarkdownFileDelivery({ dataDir }).sendFailure({
      weekId: '2026-W42',
      message: 'boom',
    });

    expect(await readdir(join(dataDir, '2026-10-12', 'digest'))).toEqual(['2026-W42.failed.md']);
  });

  it('is the configured dir when set, else the data folder (from the config)', () => {
    const dataDir = 'dist';
    expect(markdownFileOptions({ dataDir, delivery: { markdown: { dir: 'out' } } })).toEqual({
      dir: 'out',
    });
    expect(markdownFileOptions({ dataDir, delivery: { markdown: {} } })).toEqual({ dataDir });
    expect(markdownFolder({ dir: 'out' }, '2026-W42')).toBe('out');
    expect(markdownFolder({ dataDir }, '2026-W42')).toBe(join('dist', '2026-10-12', 'digest'));
  });
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

    it('drops invisible characters from the Markdown it writes and keeps its lines', async () => {
      const markdown =
        '# Digest\u{202E}\n\n- [Ollama\u{200B}0.9](https://example.com/a)\n  - nested\u{E0041}item \n';
      await createMarkdownFileDelivery({ dir }).sendDigest({ ...message, markdown });

      expect(await readFile(join(dir, '2026-W42.md'), 'utf8')).toBe(
        '# Digest\n\n- [Ollama 0.9](https://example.com/a)\n  - nested item\n',
      );
    });

    it('writes a Markdown that has none exactly as it is', async () => {
      const markdown = '# Digest\n\n| a | b |\n|---|---|\n| [x](https://example.com/x) | y |\n';
      await createMarkdownFileDelivery({ dir }).sendDigest({ ...message, markdown });

      expect(await readFile(join(dir, '2026-W42.md'), 'utf8')).toBe(markdown);
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

    it('drops invisible characters from the error, as the digest file does', async () => {
      await createMarkdownFileDelivery({ dir }).sendFailure({
        weekId: '2026-W42',
        step: 'write',
        message: 'Draft said\u{202E}stop\u{200B}now\n  second line',
      });

      const note = await readFile(join(dir, '2026-W42.failed.md'), 'utf8');
      expect(note).toBe(
        '# Weekly digest 2026-W42 failed at write\n\n- Step: write\n- Error: Draft said stop now\n  second line\n',
      );
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
