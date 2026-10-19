// The 60 labeled classifier cases (W3-02): real items from the recorded weeks plus synthetic edge
// cases. The maintainer owns the labels; these tests guard the shape, the mix and the balance.
import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { SPEC_EVAL_SET } from './cases/evalSet';
import { ClassifierCasesFileSchema } from './schema';
import { DEFAULT_FOCUS_AREAS } from '../src/sources/defaultSources';
import { OTHER_AREA, areaOptions } from '../src/classify/classifyPrompt';
import { ItemSchema, WEEK_ID_PATTERN, type Item } from '../src/domain/schemas';
import { itemIdFor, normalizeUrl, sameUrl } from '../src/shared/url';

const evalsDir = join(import.meta.dirname);

/** The fetchers truncate summaries at 600 characters (src/sources/adapters/rss.ts). */
const MAX_SUMMARY_CHARS = 600;
const RELEVANCE_LEVELS = [0, 1, 2, 3] as const;
/**
 * Balance: no area or relevance level may be starved or dominate the set. The bounds are loose on
 * purpose, so that the maintainer's label edits do not trip them; the drafted set sits well inside.
 */
const MIN_PER_AREA = 10;
const MAX_PER_AREA = 35;
const MIN_PER_RELEVANCE = 8;
const MAX_PER_RELEVANCE = 25;
/** Every focus area must show the classifier at least this many of the four relevance levels. */
const MIN_LEVELS_PER_FOCUS_AREA = 3;
/** Most cases are real items; the synthetic ones exist for the edge cases the weeks lack. */
const MIN_REAL_CASES = 40;

/** The synthetic edge cases, by kind; the spec names funding, minor patch and duplicate. */
const EDGE_CASE_URLS = {
  funding: [
    'https://quillfeather.example/blog/series-c',
    'https://brackenfold.example/news/funding-round',
  ],
  'minor-patch': [
    'https://git.example/parsewright/parsewright/releases/tag/v2.4.3',
    'https://git.example/tilewright/tilewright/releases/tag/v0.19.1',
  ],
  duplicate: [
    'https://gridlane.example/blog/gridlane-2-ambient-mode',
    'https://news.gridlane.example/posts/gridlane-2-ambient-mode',
  ],
  marketing: [
    'https://zephyrine.example/blog/ai-first-engineering-org',
    'https://lumenbay.example/blog/ai-concierge-customer-touchpoints',
  ],
  'security-advisory': [
    'https://stoneware.example/security/SW-2026-009',
    'https://tensorbarn.example/security/TB-2026-003',
  ],
  deprecation: [
    'https://ironvale.example/blog/cli-v1-deprecation',
    'https://dunmore.example/news/embed-v1-retirement',
  ],
  'release-candidate': [
    'https://git.example/halyard/halyard/releases/tag/v1.0.0-rc.2',
    'https://git.example/tidewater/tidewater/releases/tag/v3.5.0-rc.1',
  ],
} as const;

const ALL_EDGE_URLS: readonly string[] = Object.values(EDGE_CASE_URLS).flat();

async function readCasesJson(): Promise<unknown> {
  return JSON.parse(await readFile(join(evalsDir, 'classifier-cases.json'), 'utf8'));
}

async function recordedItems(): Promise<Map<string, Item>> {
  const weeksDir = join(evalsDir, 'weeks');
  const weeks = (await readdir(weeksDir)).filter((name) => WEEK_ID_PATTERN.test(name)).sort();
  const lists = await Promise.all(
    weeks.map(async (week) =>
      ItemSchema.array().parse(
        JSON.parse(await readFile(join(weeksDir, week, 'items.json'), 'utf8')),
      ),
    ),
  );
  return new Map(lists.flat().map((item) => [item.id, item]));
}

const isSynthetic = (item: Item): boolean => new URL(item.url).hostname.endsWith('.example');

function countBy<T extends string | number>(values: readonly T[]): Map<T, number> {
  const counts = new Map<T, number>();
  for (const value of values) counts.set(value, (counts.get(value) ?? 0) + 1);
  return counts;
}

const rawCases = await readCasesJson();
const recorded = await recordedItems();
/** The area labels the classifier can answer with under the default (example) config. */
const areas = areaOptions(DEFAULT_FOCUS_AREAS);
const focusAreas = areas.filter((area) => area !== OTHER_AREA);

const file = ClassifierCasesFileSchema.parse(rawCases);

describe('classifier cases file', () => {
  it('parses with ClassifierCasesFileSchema', () => {
    const parsed = ClassifierCasesFileSchema.safeParse(rawCases);
    expect(parsed.success, parsed.success ? '' : parsed.error.message).toBe(true);
  });

  it('holds the 60 cases the spec asks for', () => {
    expect(file.cases).toHaveLength(SPEC_EVAL_SET.classifier);
  });

  it('gives every case a whole relevance from 0 to 3', () => {
    for (const { item, expected } of file.cases) {
      expect(RELEVANCE_LEVELS, item.title).toContain(expected.relevance);
    }
  });

  it('labels every case with a focus area from the example config, or "other"', () => {
    expect(areas).toContain(OTHER_AREA);
    for (const { item, expected } of file.cases) {
      expect(areas, `${item.title}: ${expected.area}`).toContain(expected.area);
    }
  });
});

describe('classifier case items', () => {
  it('has unique item ids and unique URLs', () => {
    const ids = file.cases.map((c) => c.item.id);
    const urls = file.cases.map((c) => normalizeUrl(c.item.url));
    expect(new Set(ids).size).toBe(ids.length);
    expect(new Set(urls).size).toBe(urls.length);
  });

  it('uses the real id scheme: the id is the hash of the URL', () => {
    for (const { item } of file.cases) expect(item.id, item.url).toBe(itemIdFor(item.url));
  });

  it('takes real items unchanged from the recorded weeks', () => {
    const real = file.cases.map((c) => c.item).filter((item) => !isSynthetic(item));
    expect(real.length).toBeGreaterThanOrEqual(MIN_REAL_CASES);
    for (const item of real) expect(recorded.get(item.id), item.title).toEqual(item);
  });

  it('writes synthetic items with fictional hosts, no recorded id, and a collectable summary', () => {
    const synthetic = file.cases.map((c) => c.item).filter(isSynthetic);
    expect(synthetic).toHaveLength(ALL_EDGE_URLS.length);
    for (const item of synthetic) {
      expect(recorded.has(item.id), item.title).toBe(false);
      expect(item.title.length, item.url).toBeGreaterThan(0);
      expect(item.summary.length, item.title).toBeLessThanOrEqual(MAX_SUMMARY_CHARS);
      expect(item.summary.length, item.title).toBeGreaterThan(0);
    }
  });
});

describe('edge cases', () => {
  it.each(Object.entries(EDGE_CASE_URLS))('includes the %s cases', (_kind, urls) => {
    const missing = urls.filter((url) => !file.cases.some((c) => sameUrl(c.item.url, url)));
    expect(missing).toEqual([]);
  });

  it('lists each edge case once, and the file holds no other synthetic case', () => {
    expect(new Set(ALL_EDGE_URLS.map((url) => normalizeUrl(url))).size).toBe(ALL_EDGE_URLS.length);
    const synthetic = file.cases.filter((c) => isSynthetic(c.item));
    expect(synthetic.map((c) => c.item.url).sort()).toEqual([...ALL_EDGE_URLS].sort());
  });

  // By design: the classifier scores one item at a time, and dropping duplicates is another step.
  it('labels a duplicate post and its original the same way', () => {
    const [original, repost] = EDGE_CASE_URLS.duplicate.map((url) =>
      file.cases.find((c) => sameUrl(c.item.url, url)),
    );
    expect(original).toBeDefined();
    expect(repost).toBeDefined();
    expect(repost?.expected).toEqual(original?.expected);
  });
});

describe('balance', () => {
  it('spreads cases across the focus areas and "other"', () => {
    const counts = countBy(file.cases.map((c) => c.expected.area));
    for (const area of areas) {
      expect(counts.get(area) ?? 0, area).toBeGreaterThanOrEqual(MIN_PER_AREA);
      expect(counts.get(area) ?? 0, area).toBeLessThanOrEqual(MAX_PER_AREA);
    }
  });

  it('spreads cases across relevance 0-3', () => {
    const counts = countBy(file.cases.map((c) => c.expected.relevance));
    for (const level of RELEVANCE_LEVELS) {
      expect(counts.get(level) ?? 0, `relevance ${level}`).toBeGreaterThanOrEqual(
        MIN_PER_RELEVANCE,
      );
      expect(counts.get(level) ?? 0, `relevance ${level}`).toBeLessThanOrEqual(MAX_PER_RELEVANCE);
    }
  });

  it('shows the classifier several relevance levels inside each focus area', () => {
    for (const area of focusAreas) {
      const levels = new Set(
        file.cases.filter((c) => c.expected.area === area).map((c) => c.expected.relevance),
      );
      expect(levels.size, area).toBeGreaterThanOrEqual(MIN_LEVELS_PER_FOCUS_AREA);
    }
  });
});
