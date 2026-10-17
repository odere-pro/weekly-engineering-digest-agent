import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  DIGEST_MAX_ITEMS,
  DIGEST_MIN_ITEMS,
  DIGEST_WORD_LIMIT,
  formatCheck,
} from '../../../src/core/checks/formatCheck.js';
import type * as FormatCheckModule from '../../../src/core/checks/formatCheck.js';
import * as promptModule from '../../../src/core/prompts/write.js';
import { renderDigest } from '../../../src/core/render.js';
import type { Digest } from '../../../src/core/schemas.js';
import { makeDigest, makeItem } from '../../builders.js';

const check = (digest: Digest) => formatCheck(digest, renderDigest(digest, { disabledGuards: [] }));
const digestOf = (n: number): Digest => makeDigest(Array.from({ length: n }, () => makeItem()));
const withFirst = (d: Digest, patch: Partial<Digest['items'][number]>): Digest => ({
  ...d,
  items: [{ ...d.items[0]!, ...patch }, ...d.items.slice(1)],
});

describe('formatCheck', () => {
  it.each([3, 4, 5])('passes a clean digest with %i items', (n) => {
    expect(check(digestOf(n))).toEqual({ ok: true, problems: [] });
  });

  it.each([2, 6])('rejects %i items', (n) => {
    const result = check(digestOf(n));

    expect(result.ok).toBe(false);
    expect(result.problems[0]).toContain('3-5 items');
  });

  it.each([
    ['headline', (d: Digest): Digest => ({ ...d, headline: ' ' })],
    ['intro', (d: Digest): Digest => ({ ...d, intro: '' })],
    ['summary', (d: Digest): Digest => withFirst(d, { summary: '' })],
    ['why-it-matters', (d: Digest): Digest => withFirst(d, { whyItMatters: '  ' })],
  ])('rejects an empty %s', (name, mutate) => {
    const result = check(mutate(digestOf(3)));

    expect(result.ok).toBe(false);
    expect(result.problems.join('\n')).toContain(name);
  });

  it('rejects an em dash', () => {
    const result = check(withFirst(digestOf(3), { summary: 'Fast — very fast.' }));

    expect(result.ok).toBe(false);
    expect(result.problems.join('\n')).toContain('em dash');
  });

  it('rejects 500 or more words', () => {
    const result = check(withFirst(digestOf(3), { summary: 'word '.repeat(500) }));

    expect(result.ok).toBe(false);
    expect(result.problems.join('\n')).toContain('500 words');
  });

  it('does not count link targets as words', () => {
    const d = withFirst(digestOf(3), { summary: 'word '.repeat(380) });
    const md = renderDigest(d, { disabledGuards: [] });
    const long = `${md}\n[x](https://example.com/${'a/'.repeat(400)})`;

    expect(formatCheck(d, long).ok).toBe(true);
  });

  it('reports several problems at once', () => {
    const result = check({ ...digestOf(2), headline: '' });

    expect(result.problems.length).toBeGreaterThanOrEqual(2);
  });
});

describe('formatCheck word limit', () => {
  it('counts prose hidden between "](" and ")"', () => {
    const d = digestOf(3);
    const md = `${renderDigest(d, { disabledGuards: [] })}\nfoo](${'word '.repeat(600)})`;

    expect(formatCheck(d, md).ok).toBe(false);
  });
});

describe('formatCheck limits (F32)', () => {
  it('exports the limits the write prompt shows the writer', () => {
    expect([DIGEST_MIN_ITEMS, DIGEST_MAX_ITEMS, DIGEST_WORD_LIMIT]).toEqual([3, 5, 500]);
  });

  it('uses the exported limits at their edges', () => {
    expect(check(digestOf(DIGEST_MIN_ITEMS - 1)).ok).toBe(false);
    expect(check(digestOf(DIGEST_MIN_ITEMS)).ok).toBe(true);
    expect(check(digestOf(DIGEST_MAX_ITEMS)).ok).toBe(true);
    expect(check(digestOf(DIGEST_MAX_ITEMS + 1)).ok).toBe(false);
  });

  it('names the exported limits in its problems', () => {
    const itemProblems = check(digestOf(DIGEST_MAX_ITEMS + 1)).problems.join('\n');
    const wordProblems = check(
      withFirst(digestOf(3), { summary: 'word '.repeat(DIGEST_WORD_LIMIT) }),
    ).problems.join('\n');

    expect(itemProblems).toContain(`${DIGEST_MIN_ITEMS}-${DIGEST_MAX_ITEMS} items`);
    expect(wordProblems).toContain(`under ${DIGEST_WORD_LIMIT} words`);
  });

  describe('in the write prompt', () => {
    afterEach(() => {
      vi.doUnmock('../../../src/core/checks/formatCheck.js');
      vi.resetModules();
    });

    it('re-exports the same numbers', () => {
      expect(promptModule.DIGEST_MIN_ITEMS).toBe(DIGEST_MIN_ITEMS);
      expect(promptModule.DIGEST_MAX_ITEMS).toBe(DIGEST_MAX_ITEMS);
      expect(promptModule.DIGEST_WORD_LIMIT).toBe(DIGEST_WORD_LIMIT);
    });

    it('follows the check when its limits change, so the two cannot drift apart', async () => {
      vi.resetModules();
      vi.doMock('../../../src/core/checks/formatCheck.js', async (importOriginal) => ({
        ...(await importOriginal<typeof FormatCheckModule>()),
        DIGEST_MIN_ITEMS: 2,
        DIGEST_MAX_ITEMS: 7,
        DIGEST_WORD_LIMIT: 650,
      }));

      const changed = await import('../../../src/core/prompts/write.js');
      const { system } = changed.buildWritePrompt([], ['Platform engineering']);

      expect(system).toContain('2 to 7 items');
      expect(system).toContain('under 650 words');
      expect(changed.DIGEST_MAX_ITEMS).toBe(7);
    });
  });
});
