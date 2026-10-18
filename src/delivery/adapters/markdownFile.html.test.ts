import { mkdtemp, mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { renderEmailHtml } from './emailRender';
import { createMarkdownFileDelivery, digestFilePaths } from './markdownFile';
import { writeFileAtomic } from '../../store/adapters/atomicFile';
import type { DigestMessage, DigestView } from '../Delivery';

// Delegates to the real writer, so tests can assert both files go through the atomic path.
vi.mock('../../store/adapters/atomicFile', async (importOriginal) => {
  const actual = await importOriginal<{ writeFileAtomic: typeof writeFileAtomic }>();
  return { ...actual, writeFileAtomic: vi.fn(actual.writeFileAtomic) };
});

const view: DigestView = {
  weekId: '2026-W42',
  title: 'Week 2026-W42: 2 releases, 1 needs action',
  headline: 'Runners moved and a gateway broke.',
  groups: [
    {
      urgency: 'act-now',
      label: 'Act now',
      items: [
        {
          title: 'Gateway 2.0',
          url: 'https://example.com/gateway',
          whatChanged: 'The v1 API is removed.',
          action: 'Move off v1 before upgrading.',
        },
      ],
    },
    {
      urgency: 'good-to-know',
      label: 'Good to know',
      items: [
        {
          title: 'Runner 9',
          url: 'https://example.com/runner',
          whatChanged: 'Faster cold starts.',
        },
      ],
    },
  ],
};

const message: DigestMessage = {
  weekId: '2026-W42',
  subject: 'Engineering digest 2026-W42',
  markdown: '# Week 2026-W42\n\n| Release |\n',
};

let root: string;
let dir: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'delivery-md-html-'));
  dir = join(root, 'digests');
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe('digestFilePaths', () => {
  it('names the Markdown and HTML file of a week inside the folder', () => {
    expect(digestFilePaths('dist/digests', '2026-W42')).toEqual({
      markdown: join('dist/digests', '2026-W42.md'),
      html: join('dist/digests', '2026-W42.html'),
    });
  });

  it.each(['../evil', 'a/b', '', '2026-W42.html', 'latest'])('refuses the week id %j', (weekId) => {
    expect(() => digestFilePaths(dir, weekId)).toThrow(/week id/i);
  });
});

describe('createMarkdownFileDelivery: the HTML copy', () => {
  it('writes <weekId>.html next to the Markdown when the message has a view', async () => {
    await createMarkdownFileDelivery({ dir }).sendDigest({ ...message, view });

    expect((await readdir(dir)).sort()).toEqual(['2026-W42.html', '2026-W42.md']);
    expect(await readFile(join(dir, '2026-W42.md'), 'utf8')).toBe(message.markdown);
  });

  it('writes the same HTML the email channel sends, so it opens in a browser', async () => {
    await createMarkdownFileDelivery({ dir }).sendDigest({ ...message, view });

    const html = await readFile(join(dir, '2026-W42.html'), 'utf8');
    expect(html).toBe(renderEmailHtml(view));
    expect(html).toMatch(/^<!doctype html>/);
    expect(html).toContain('Gateway 2.0');
  });

  it('writes only the Markdown when the message has no view', async () => {
    await createMarkdownFileDelivery({ dir }).sendDigest(message);

    expect(await readdir(dir)).toEqual(['2026-W42.md']);
  });

  it('writes both files through the atomic temp-file-then-rename writer', async () => {
    await createMarkdownFileDelivery({ dir }).sendDigest({ ...message, view });

    expect(writeFileAtomic).toHaveBeenCalledWith(join(dir, '2026-W42.md'), message.markdown);
    expect(writeFileAtomic).toHaveBeenCalledWith(join(dir, '2026-W42.html'), renderEmailHtml(view));
  });

  it('replaces an earlier HTML copy of the same week and leaves no temp files behind', async () => {
    const delivery = createMarkdownFileDelivery({ dir });
    await delivery.sendDigest({ ...message, view });
    const second: DigestView = { ...view, headline: 'Second run headline.' };
    await delivery.sendDigest({ ...message, markdown: '# Second run\n', view: second });

    const html = await readFile(join(dir, '2026-W42.html'), 'utf8');
    expect(html).toContain('Second run headline.');
    expect(html).not.toContain('Runners moved');
    expect((await readdir(dir)).sort()).toEqual(['2026-W42.html', '2026-W42.md']);
  });

  it('removes the HTML copy of an earlier run when the new digest has no view', async () => {
    const delivery = createMarkdownFileDelivery({ dir });
    await delivery.sendDigest({ ...message, view });

    await delivery.sendDigest({ ...message, markdown: '# Resumed without a view\n' });

    expect(await readdir(dir)).toEqual(['2026-W42.md']);
    expect(await readFile(join(dir, '2026-W42.md'), 'utf8')).toBe('# Resumed without a view\n');
  });

  it('leaves no HTML of an earlier run next to the new Markdown when writing the HTML fails', async () => {
    const delivery = createMarkdownFileDelivery({ dir });
    await delivery.sendDigest({ ...message, view });
    const actual = await vi.importActual<{ writeFileAtomic: typeof writeFileAtomic }>(
      '../../store/adapters/atomicFile',
    );
    // The Markdown is written first and goes through; the HTML write after it fails.
    vi.mocked(writeFileAtomic)
      .mockImplementationOnce(actual.writeFileAtomic)
      .mockRejectedValueOnce(new Error('disk full'));

    await expect(
      delivery.sendDigest({ ...message, markdown: '# New run\n', view }),
    ).rejects.toThrow('disk full');

    expect(await readdir(dir)).toEqual(['2026-W42.md']);
    expect(await readFile(join(dir, '2026-W42.md'), 'utf8')).toBe('# New run\n');
  });

  it('keeps the HTML copies of other weeks', async () => {
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, '2026-W41.html'), '<p>last week</p>');

    await createMarkdownFileDelivery({ dir }).sendDigest(message);

    expect(await readFile(join(dir, '2026-W41.html'), 'utf8')).toBe('<p>last week</p>');
  });

  it('writes nothing, not even the Markdown, for an invalid week id', async () => {
    const delivery = createMarkdownFileDelivery({ dir });

    await expect(delivery.sendDigest({ ...message, weekId: '../evil', view })).rejects.toThrow(
      /week id/i,
    );
    expect(await readdir(root)).toEqual([]);
  });

  it('does not touch the failure note of the same week', async () => {
    const delivery = createMarkdownFileDelivery({ dir });
    await delivery.sendFailure({ weekId: '2026-W42', message: 'earlier failure' });

    await delivery.sendDigest({ ...message, view });

    expect((await readdir(dir)).sort()).toEqual([
      '2026-W42.failed.md',
      '2026-W42.html',
      '2026-W42.md',
    ]);
  });
});
