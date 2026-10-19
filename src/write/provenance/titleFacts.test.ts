import { describe, expect, it, vi } from 'vitest';
import type { ScoredItem } from '../../classify/classification';
import type { DigestItem } from '../../domain/schemas';
import type { Logger } from '../../shared/telemetry';
import { groundTitle, groundTitles } from './titleFacts';
import { makeDigestItem, makeScoredItem } from '../../../test/builders';
import { noopLogger } from '../../../test/fakes';

function spyLogger(): { logger: Logger; warn: ReturnType<typeof vi.fn> } {
  const warn = vi.fn();
  const logger: Logger = { ...noopLogger, warn, child: () => logger };
  return { logger, warn };
}

function sourceOf(title: string, summary = 'A release of the project.'): ScoredItem {
  return makeScoredItem({ title, summary });
}

/** The item as the writer returned it for `source`, with `title` over the source's own. */
function itemFor(source: ScoredItem, title: string): DigestItem {
  return makeDigestItem(source, { title });
}

/** `groundTitle` with a logger that records nothing; returns the item it gave back. */
function grounded(source: ScoredItem, title: string): DigestItem {
  return groundTitle(itemFor(source, title), source, noopLogger);
}

describe('groundTitle', () => {
  describe('keeps the writer title', () => {
    it('when it has no version, advisory id or date', () => {
      const source = sourceOf('Kubernetes v1.31.2');
      const item = itemFor(source, 'Kubernetes ships a patch release');

      expect(groundTitle(item, source, noopLogger)).toBe(item);
    });

    it('when its version is in the source title', () => {
      const source = sourceOf('Kubernetes v1.31.2');

      expect(grounded(source, 'Kubernetes 1.31.2 fixes a scheduler bug').title).toBe(
        'Kubernetes 1.31.2 fixes a scheduler bug',
      );
    });

    it('when its version is only in the source summary', () => {
      const source = sourceOf('Release notes', 'This is v3.4.5 of the runner.');

      expect(grounded(source, 'Runner 3.4.5 is out').title).toBe('Runner 3.4.5 is out');
    });

    it('when its CVE id and date are in the source', () => {
      const source = sourceOf('Advisory CVE-2026-1234', 'Fixed on 2026-10-12.');
      const title = 'CVE-2026-1234 fixed on 2026-10-12';

      expect(grounded(source, title).title).toBe(title);
    });

    it('when it names a shorter version than the source has, up to a dot', () => {
      const source = sourceOf('Kubernetes v1.31.2');

      expect(grounded(source, 'Kubernetes 1.31 patch release').title).toBe(
        'Kubernetes 1.31 patch release',
      );
    });

    it('when its shorter version is a prefix of a source version in the summary', () => {
      const source = sourceOf('Patch release', 'Kubernetes 1.31.2 is out.');

      expect(grounded(source, 'Kubernetes 1.31 gets a patch').title).toBe(
        'Kubernetes 1.31 gets a patch',
      );
    });

    it('when its shorter version is a prefix of a four-number source version', () => {
      const source = sourceOf('Build 10.4.2.1');

      expect(grounded(source, 'Build 10.4 lands').title).toBe('Build 10.4 lands');
    });
  });

  describe('repairs the writer title', () => {
    it('with the source title when its version is not in the source', () => {
      const source = sourceOf('Kubernetes v1.31.2');

      expect(grounded(source, 'Kubernetes 1.32.0 fixes a scheduler bug').title).toBe(
        'Kubernetes v1.31.2',
      );
    });

    it('when a shorter version is not a prefix at a dot (1.3 is not 1.31.2)', () => {
      const source = sourceOf('Kubernetes v1.31.2');

      expect(grounded(source, 'Kubernetes 1.3 patch').title).toBe('Kubernetes v1.31.2');
    });

    it('when a longer version is not in the source (1.31.3 is not 1.31.2)', () => {
      const source = sourceOf('Kubernetes v1.31.2');

      expect(grounded(source, 'Kubernetes 1.31.3').title).toBe('Kubernetes v1.31.2');
    });

    it('when the title adds a pre-release the source does not have', () => {
      const source = sourceOf('terraform v1.17.0');

      expect(grounded(source, 'Terraform 1.17.0-rc.1').title).toBe('terraform v1.17.0');
    });

    it.each([
      ['terraform v1.17.0-beta1', 'Terraform 1.17 arrives'],
      ['Python 3.12.0b1', 'Python 3.12 is out'],
      ['tool 2.0.1-rc.1', 'tool 2.0 is out'],
    ])(
      'when the source is a pre-release (%s) and the title names a shorter version',
      (src, title) => {
        expect(grounded(sourceOf(src), title).title).toBe(src);
      },
    );

    it('when the source is a pre-release and the title names the final version', () => {
      const source = sourceOf('terraform v1.17.0-beta1');

      expect(grounded(source, 'Terraform 1.17.0 arrives').title).toBe('terraform v1.17.0-beta1');
    });

    it('when a CVE id is not in the source', () => {
      const source = sourceOf('Security fix', 'Fixes CVE-2026-1111.');

      expect(grounded(source, 'Fix for CVE-2026-2222').title).toBe('Security fix');
    });

    it('when a date is not in the source', () => {
      const source = sourceOf('Retirement notice', 'Ends on 2026-11-10.');

      expect(grounded(source, 'Retires on 2026-12-10').title).toBe('Retirement notice');
    });

    it('when only one of two versions is in the source', () => {
      const source = sourceOf('tool v2.0.0');

      expect(grounded(source, 'tool 2.0.0 and 2.0.1').title).toBe('tool v2.0.0');
    });

    it('with the source title on one line, without invisible characters', () => {
      const source = sourceOf('tool​ v2.0.0:\n  the   big one');

      expect(grounded(source, 'tool 9.9.9').title).toBe('tool v2.0.0: the big one');
    });

    it('keeps every other field of the item', () => {
      const source = sourceOf('tool v2.0.0');
      const item = {
        ...itemFor(source, 'tool 9.9.9'),
        urgency: 'act-now' as const,
        action: 'Upgrade today.',
      };

      expect(groundTitle(item, source, noopLogger)).toEqual({ ...item, title: 'tool v2.0.0' });
    });
  });

  describe('the source title it uses', () => {
    it.each([
      ['a url', 'tool v2.0.0 see https://evil.example/x now', 'tool v2.0.0 see now'],
      ['a www address', 'tool v2.0.0 www.example.com/x docs', 'tool v2.0.0 docs'],
      ['a link', 'tool v2.0.0 [docs](x) here', 'tool v2.0.0 here'],
      ['a character reference', 'tool v2.0.0 &#99999999; ok', 'tool v2.0.0 ok'],
      ['a named reference', 'tool v2.0.0 &amp; ok', 'tool v2.0.0 ok'],
    ])('leaves out a token with %s, so the link check does not reject it', (_name, title, kept) => {
      expect(grounded(sourceOf(title), 'tool 9.9.9').title).toBe(kept);
    });

    it('is cut to 120 characters at a word', () => {
      const long = `tool v2.0.0 ${'word '.repeat(100)}`;

      const title = grounded(sourceOf(long), 'tool 9.9.9').title;

      expect(title.length).toBeLessThanOrEqual(120);
      expect(title.startsWith('tool v2.0.0 word word')).toBe(true);
      expect(title.endsWith('...')).toBe(true);
    });

    it('is as collected when it is short and clean', () => {
      const title = '[Launched] Generally Available: Playwright Workspaces in Japan East';

      expect(grounded(sourceOf(title), 'Playwright 9.9.9').title).toBe(title);
    });

    it('leaves the item alone when nothing usable is left of it', () => {
      const source = sourceOf('https://evil.example/x', 'No version here.');
      const item = itemFor(source, 'tool 9.9.9');

      expect(groundTitle(item, source, noopLogger)).toBe(item);
    });
  });

  it('leaves the item alone when the source has no title to use', () => {
    const source = sourceOf('  \n ', 'No version here.');
    const item = itemFor(source, 'tool 9.9.9');

    expect(groundTitle(item, source, noopLogger)).toBe(item);
  });

  it('does not change the item or the source it is given', () => {
    const source = sourceOf('tool v2.0.0');
    const item = itemFor(source, 'tool 9.9.9');
    const frozenItem = Object.freeze({ ...item });
    const frozenSource = Object.freeze({ ...source });

    const result = groundTitle(frozenItem, frozenSource, noopLogger);

    expect(result).not.toBe(frozenItem);
    expect(frozenItem.title).toBe('tool 9.9.9');
    expect(frozenSource.title).toBe('tool v2.0.0');
  });

  describe('log', () => {
    it('warns once with the item id and the missing facts, in text order', () => {
      const { logger, warn } = spyLogger();
      const source = sourceOf('tool v2.0.0');
      const item = { ...itemFor(source, 'tool 2.0.0, 9.9.9 and 2026-01-02'), itemId: 'item-x' };

      groundTitle(item, source, logger);

      expect(warn).toHaveBeenCalledTimes(1);
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('title'), {
        itemId: 'item-x',
        missing: ['9.9.9', '2026-01-02'],
        missingCount: 2,
      });
    });

    it('cuts a long item id to 80 characters and each fact to 40', () => {
      const { logger, warn } = spyLogger();
      const source = sourceOf('tool v2.0.0');
      const longFact = `1.0.0-rc.${Array.from({ length: 30 }, (_, i) => i + 1).join('.')}`;
      const item = { ...itemFor(source, `tool ${longFact}`), itemId: 'i'.repeat(300) };

      groundTitle(item, source, logger);

      const fields = warn.mock.calls[0]?.[1] as { itemId: string; missing: string[] };
      expect(fields.itemId.length).toBeLessThanOrEqual(80);
      expect(fields.missing).toHaveLength(1);
      expect(fields.missing[0]!.length).toBeLessThanOrEqual(40);
      expect(longFact.length).toBeGreaterThan(40);
    });

    it('lists at most five facts and counts the rest', () => {
      const { logger, warn } = spyLogger();
      const source = sourceOf('tool v2.0.0');
      const many = Array.from({ length: 1_000 }, (_, i) => `${i + 10}.9.9`).join(' ');

      groundTitle(itemFor(source, `tool ${many}`), source, logger);

      const fields = warn.mock.calls[0]?.[1] as { missing: string[]; missingCount: number };
      expect(fields.missing).toEqual(['10.9.9', '11.9.9', '12.9.9', '13.9.9', '14.9.9']);
      expect(fields.missingCount).toBe(1_000);
    });

    it('stays quiet when the title is kept', () => {
      const { logger, warn } = spyLogger();
      const source = sourceOf('tool v2.0.0');

      groundTitle(itemFor(source, 'tool 2.0 is out'), source, logger);

      expect(warn).not.toHaveBeenCalled();
    });

    it('warns that nothing was repaired when the source has no title to use', () => {
      const { logger, warn } = spyLogger();
      const source = sourceOf('', 'No version here.');

      groundTitle(itemFor(source, 'tool 9.9.9'), source, logger);

      expect(warn).toHaveBeenCalledTimes(1);
      expect(warn.mock.calls[0]?.[0]).toMatch(/no title/i);
    });
  });
});

describe('groundTitles', () => {
  it('grounds each item in the source its itemId names', () => {
    const first = sourceOf('tool v1.0.0');
    const second = sourceOf('other v2.0.0');
    const index = new Map([first, second].map((source) => [source.id, source]));

    const result = groundTitles(
      [itemFor(first, 'tool 9.9.9'), itemFor(second, 'other 2.0.0')],
      index,
      noopLogger,
    );

    expect(result.map((item) => item.title)).toEqual(['tool v1.0.0', 'other 2.0.0']);
  });

  it('returns an item with no source as it is', () => {
    const orphan = itemFor(sourceOf('tool v1.0.0'), 'tool 9.9.9');

    expect(groundTitles([orphan], new Map(), noopLogger)).toEqual([orphan]);
  });
});
