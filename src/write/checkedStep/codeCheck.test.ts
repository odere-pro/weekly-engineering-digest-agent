import { describe, expect, it } from 'vitest';
import type { Digest, Draft } from '../../domain/schemas';
import { renderDigest } from '../../render/markdown';
import { codeCheck } from './codeCheck';
import { makeDigest, makeItem } from '../../../test/builders';

const items = [makeItem(), makeItem(), makeItem()];
const RENDER = { disabledGuards: [] } as const;

const draftOf = (overrides: Partial<Digest> = {}): Draft => ({
  writer: 'writer-a',
  digest: makeDigest(items, overrides),
});

/** A headline far over the word limit: the format check rejects it and nothing else does. */
const LONG_HEADLINE = 'word '.repeat(600).trim();

describe('codeCheck', () => {
  it('passes a clean draft, with the Markdown that was checked', () => {
    const draft = draftOf();

    const result = codeCheck(draft, items, RENDER);

    expect(result.rejectedBy).toEqual([]);
    expect(result.problems).toEqual([]);
    expect(result.draft).toBe(draft);
    expect(result.markdown).toBe(renderDigest(draft.digest, RENDER));
  });

  it('rejects a draft with a link that is not a collected url, by the link check', () => {
    const draft = draftOf({ intro: 'See https://evil.example/payload today.' });

    const result = codeCheck(draft, items, RENDER);

    expect(result.rejectedBy).toEqual(['linkCheck']);
    expect(result.problems).toEqual([
      'Unknown URL not in collected items: https://evil.example/payload',
    ]);
  });

  it('rejects a draft that breaks the format, by the format check', () => {
    const result = codeCheck(draftOf({ headline: LONG_HEADLINE }), items, RENDER);

    expect(result.rejectedBy).toEqual(['formatCheck']);
    expect(result.problems).toEqual([expect.stringMatching(/^Expected under 500 words, got \d+/)]);
  });

  it('names both checks, link first, and lists the format problems before the link problems', () => {
    const draft = draftOf({ headline: LONG_HEADLINE, intro: 'See https://evil.example/x.' });

    const result = codeCheck(draft, items, RENDER);

    expect(result.rejectedBy).toEqual(['linkCheck', 'formatCheck']);
    expect(result.problems[0]).toMatch(/^Expected under 500 words/);
    expect(result.problems.at(-1)).toBe(
      'Unknown URL not in collected items: https://evil.example/x',
    );
  });

  it('checks the digest as it will be rendered, with the footer for a disabled guard', () => {
    const draft = draftOf();

    const result = codeCheck(draft, items, { disabledGuards: ['clefRubric'] });

    expect(result.markdown).toBe(renderDigest(draft.digest, { disabledGuards: ['clefRubric'] }));
    expect(result.markdown).not.toBe(renderDigest(draft.digest, RENDER));
  });

  it('does not change the draft it was given', () => {
    const draft = draftOf();
    const snapshot = structuredClone(draft);

    codeCheck(draft, items, RENDER);

    expect(draft).toEqual(snapshot);
  });
});
