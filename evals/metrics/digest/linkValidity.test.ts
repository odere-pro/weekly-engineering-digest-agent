import { describe, expect, it } from 'vitest';
import { linkValidity } from './linkValidity';
import type { DigestSample } from './digestSample';
import { MAX_PROBLEM_CHARS } from '../measurement/weekDetail';
import { renderDigest } from '../../../src/render/markdown';
import type { Item } from '../../../src/domain/schemas';
import { makeDigest, makeItem } from '../../../test/builders';

const makeItems = (count: number): Item[] => Array.from({ length: count }, () => makeItem());

function sampleFor(
  items: readonly Item[],
  digestItems: readonly Item[] = items,
  weekId = '2026-W42',
): DigestSample {
  const markdown = renderDigest(makeDigest(digestItems, { weekId }), { disabledGuards: [] });
  return { weekId, markdown, items };
}

describe('linkValidity', () => {
  it('is 1 when every digest only links to collected items', () => {
    const items = makeItems(4);
    expect(linkValidity([sampleFor(items), sampleFor(items)]).value).toBe(1);
  });

  it('drops when a digest links to a URL that was not collected', () => {
    const items = makeItems(4);
    const other = makeItem();
    const bad = sampleFor(items, [...items.slice(0, 3), other]);
    expect(linkValidity([sampleFor(items), bad]).value).toBe(0.5);
  });

  it('skips weeks without a digest and is null with none at all', () => {
    const items = makeItems(3);
    const none: DigestSample = { weekId: '2026-W41', markdown: undefined, items };
    expect(linkValidity([sampleFor(items), none]).value).toBe(1);
    expect(linkValidity([none]).value).toBeNull();
    expect(linkValidity([]).value).toBeNull();
  });
});

describe('linkValidity by week', () => {
  it('lists each replayed week with its status and no problems when all links are collected', () => {
    const items = makeItems(4);

    const result = linkValidity([sampleFor(items, items, '2026-W40')]);

    expect(result.byWeek).toEqual({
      '2026-W40': { status: 'ok', problems: [], problemCount: 0 },
    });
  });

  it('names the link problems of a week that links to a URL nobody collected', () => {
    const items = makeItems(4);
    const stranger = makeItem({ url: 'https://stranger.example/post' });

    const result = linkValidity([
      sampleFor(items, items, '2026-W40'),
      sampleFor(items, [...items.slice(0, 3), stranger], '2026-W41'),
    ]);

    const failed = result.byWeek?.['2026-W41'];
    expect(failed?.status).toBe('failed');
    expect(failed?.problemCount).toBeGreaterThan(0);
    expect(failed?.problems.join(' ')).toContain('stranger.example');
    expect(result.byWeek?.['2026-W40']?.status).toBe('ok');
    expect(result.value).toBe(0.5);
  });

  it('marks a week without a digest and keeps it out of the value', () => {
    const items = makeItems(3);
    const none: DigestSample = { weekId: '2026-W41', markdown: undefined, items };

    const result = linkValidity([sampleFor(items), none]);

    expect(result.byWeek?.['2026-W41']).toEqual({
      status: 'no-digest',
      problems: [],
      problemCount: 0,
    });
    expect(result.value).toBe(1);
  });

  it('keys a replay by its label when two replays share a week', () => {
    const items = makeItems(3);

    const result = linkValidity([
      sampleFor(items, items, '2026-W40'),
      { ...sampleFor(items, items, '2026-W40'), label: '2026-W40 with attacks' },
    ]);

    expect(Object.keys(result.byWeek ?? {})).toEqual(['2026-W40', '2026-W40 with attacks']);
  });

  it('numbers a repeated label, so no replay is lost from the detail', () => {
    const items = makeItems(3);

    const result = linkValidity([
      sampleFor(items, items, '2026-W40'),
      sampleFor(items, items, '2026-W40'),
      sampleFor(items, items, '2026-W40'),
    ]);

    expect(Object.keys(result.byWeek ?? {})).toEqual(['2026-W40', '2026-W40 (2)', '2026-W40 (3)']);
  });

  it('has no weeks to show when there are no samples', () => {
    const result = linkValidity([]);
    expect(result.value).toBeNull();
    expect(result.byWeek).toBeUndefined();
  });
});

describe('linkValidity problem messages', () => {
  it('cuts a very long problem message', () => {
    const items = makeItems(3);
    const stranger = makeItem({ url: `https://stranger.example/${'x'.repeat(500)}` });

    const result = linkValidity([sampleFor(items, [...items.slice(0, 2), stranger])]);

    const [problem] = result.byWeek?.['2026-W42']?.problems ?? [];
    expect(problem).toBeDefined();
    expect(problem?.length).toBeLessThanOrEqual(MAX_PROBLEM_CHARS);
  });
});
