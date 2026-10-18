// Test data builders. Each returns a valid object; pass overrides for what the test cares about.
import { ConfigSchema, type Config, type ConfigInput } from '../src/config/schema';
import type {
  Classification,
  Digest,
  DigestItem,
  Draft,
  Item,
  RunRecord,
  ScoredItem,
} from '../src/domain/schemas';

let seq = 0;
const next = (): number => ++seq;

export function makeItem(overrides: Partial<Item> = {}): Item {
  const n = next();
  return {
    id: `item-${n}`,
    sourceId: 'example-feed',
    kind: 'rss',
    url: `https://example.com/posts/${n}`,
    title: `Release ${n}`,
    summary: `Summary of release ${n}.`,
    publishedAt: '2026-10-12T09:00:00Z',
    ...overrides,
  };
}

export function makeClassification(
  itemId: string,
  overrides: Partial<Classification> = {},
): Classification {
  return {
    itemId,
    relevance: 2.5,
    area: 'AI models and tooling',
    areaConfidence: 0.9,
    hype: 0.1,
    minorRelease: 0.1,
    ...overrides,
  };
}

export function makeScoredItem(
  overrides: Partial<Item> = {},
  classification: Partial<Classification> = {},
): ScoredItem {
  const item = makeItem(overrides);
  return { ...item, classification: makeClassification(item.id, classification) };
}

export function makeDigestItem(item: Item, overrides: Partial<DigestItem> = {}): DigestItem {
  return {
    itemId: item.id,
    title: item.title,
    url: item.url,
    area: 'AI models and tooling',
    summary: `What shipped in ${item.title}.`,
    whyItMatters: 'It changes how teams build and run software.',
    ...overrides,
  };
}

export function makeDigest(items: readonly Item[], overrides: Partial<Digest> = {}): Digest {
  return {
    weekId: '2026-W42',
    headline: 'This week in AI and platform engineering',
    intro: 'The releases that matter this week.',
    items: items.map((item) => makeDigestItem(item)),
    ...overrides,
  };
}

export function makeDraft(
  items: readonly Item[],
  writer = 'fake-writer',
  overrides: Partial<Digest> = {},
): Draft {
  return { writer, digest: makeDigest(items, overrides) };
}

export function makeConfig(overrides: Partial<ConfigInput> = {}): Config {
  return ConfigSchema.parse({
    focusAreas: ['AI models and tooling', 'Platform engineering'],
    sources: [{ id: 'example-feed', kind: 'rss', url: 'https://example.com/feed.xml' }],
    schedule: { timeZone: 'Europe/Berlin' },
    ...overrides,
  });
}

export function makeRunRecord(overrides: Partial<RunRecord> = {}): RunRecord {
  return {
    runId: '2026-W42',
    status: 'sent',
    dryRun: false,
    startedAt: '2026-10-12T05:45:00Z',
    finishedAt: '2026-10-12T05:52:00Z',
    profile: 'quality',
    modelsByRole: {},
    timings: [],
    counts: { collected: 0, afterGuardInput: 0, classified: 0, selected: 0, digestItems: 0 },
    failedSources: [],
    disabledGuards: [],
    drafts: [],
    winner: null,
    sentUrls: [],
    ...overrides,
  };
}
