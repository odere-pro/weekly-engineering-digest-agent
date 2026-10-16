import type { ScoredItem } from '../schemas.js';
import type { Thresholds } from '../../config/schema.js';
import { DigestError } from '../../shared/errors.js';
import { normalizeUrl } from '../../shared/url.js';

export interface ProcessInput {
  items: readonly ScoredItem[];
  /** URLs already sent in recent weeks. */
  sentUrls: ReadonlySet<string>;
  thresholds: Thresholds;
  topN: number;
}

export interface ProcessOutput {
  selected: ScoredItem[];
  dropped: {
    itemId: string;
    reason:
      'duplicate' | 'sent-before' | 'low-relevance' | 'hype' | 'minor-release' | 'below-top-n';
  }[];
}

type Dropped = ProcessOutput['dropped'][number];
type DropReason = Dropped['reason'];

/** No area takes more than this many slots while another area still has an item to place. */
const MAX_SLOTS_PER_AREA = 2;

/**
 * An input item. The wrapper gives every input position its own identity, so two items with
 * equal ids (or the same object passed twice) stay distinguishable.
 */
interface Entry {
  readonly item: ScoredItem;
}

/** One filter step: given the survivors so far, say which entries it drops. */
interface Stage {
  readonly reason: DropReason;
  readonly drops: (survivors: readonly Entry[]) => (entry: Entry) => boolean;
}

interface Partition {
  readonly kept: readonly Entry[];
  readonly dropped: readonly Dropped[];
}

/** Pure ranking and filtering in code, no model calls (W1-08). */
export function processStep(input: ProcessInput): ProcessOutput {
  const { items, sentUrls, thresholds, topN } = input;
  assertTopN(topN);

  // Rank once up front: every later list (drops included) is in rank order, whatever the input order.
  const ranked = items.map((item): Entry => ({ item })).sort(byRank);
  const { kept: eligible, dropped } = filterStages(sentUrls, thresholds).reduce(applyStage, {
    kept: ranked,
    dropped: [],
  });

  const chosen = pickWithAreaSpread(eligible, topN);
  const selected = eligible.filter((entry) => chosen.has(entry));
  const belowTopN = eligible.filter((entry) => !chosen.has(entry));

  return {
    selected: selected.map(({ item }) => item),
    dropped: [...dropped, ...belowTopN.map(({ item }) => drop(item, 'below-top-n'))],
  };
}

function assertTopN(topN: number): void {
  if (!Number.isInteger(topN) || topN < 0) {
    throw new DigestError(`topN must be a non-negative integer, got ${topN}`, {
      step: 'process',
    });
  }
}

function drop(item: ScoredItem, reason: DropReason): Dropped {
  return { itemId: item.id, reason };
}

/** The drop rules in the order the contract applies them; an item gets the first reason that fits. */
function filterStages(sentUrls: ReadonlySet<string>, thresholds: Thresholds): Stage[] {
  const perItem = (reason: DropReason, test: (entry: Entry) => boolean): Stage => ({
    reason,
    drops: () => test,
  });
  return [
    perItem('sent-before', sentBefore(sentUrls)),
    { reason: 'duplicate', drops: duplicates },
    perItem('low-relevance', ({ item }) => item.classification.relevance < thresholds.minRelevance),
    perItem('hype', ({ item }) => item.classification.hype > thresholds.maxHype),
    perItem(
      'minor-release',
      ({ item }) => item.classification.minorRelease > thresholds.maxMinorRelease,
    ),
  ];
}

function applyStage(current: Partition, stage: Stage): Partition {
  const isDropped = stage.drops(current.kept);
  return {
    kept: current.kept.filter((entry) => !isDropped(entry)),
    dropped: [
      ...current.dropped,
      ...current.kept.filter(isDropped).map(({ item }) => drop(item, stage.reason)),
    ],
  };
}

function sentBefore(sentUrls: ReadonlySet<string>): (entry: Entry) => boolean {
  const sent = new Set([...sentUrls].map(normalizeUrl));
  return ({ item }) => sent.has(normalizeUrl(item.url));
}

/**
 * Entries that repeat a better-ranked one: same id, or the same normalized title from a
 * different source. `survivors` is in rank order, so the first of each story is the one kept.
 */
function duplicates(survivors: readonly Entry[]): (entry: Entry) => boolean {
  const repeats = new Set<Entry>();
  const keptIds = new Set<string>();
  const sourcesByTitle = new Map<string, ReadonlySet<string>>();

  for (const entry of survivors) {
    const { id, sourceId, title } = entry.item;
    const key = normalizeText(title);
    const titleSources = sourcesByTitle.get(key);
    const repeatsTitle =
      key !== '' && titleSources !== undefined && [...titleSources].some((s) => s !== sourceId);

    if (keptIds.has(id) || repeatsTitle) {
      repeats.add(entry);
      continue;
    }
    keptIds.add(id);
    sourcesByTitle.set(key, new Set(titleSources).add(sourceId));
  }
  return (entry) => repeats.has(entry);
}

/** Unicode-folded, lowercase, with runs of anything but letters, digits, `+` and `#` collapsed to one space. */
function normalizeText(text: string): string {
  return text
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}+#]+/gu, ' ')
    .trim();
}

/**
 * Relevance desc, areaConfidence desc, publishedAt desc, id asc. Source, title and URL only
 * settle ties between items that share an id, so the winner never depends on input order.
 */
function byRank(a: Entry, b: Entry): number {
  const ca = a.item.classification;
  const cb = b.item.classification;
  return (
    cb.relevance - ca.relevance ||
    cb.areaConfidence - ca.areaConfidence ||
    publishedMs(b.item) - publishedMs(a.item) ||
    compareStrings(a.item.id, b.item.id) ||
    compareStrings(a.item.sourceId, b.item.sourceId) ||
    compareStrings(a.item.title, b.item.title) ||
    compareStrings(a.item.url, b.item.url)
  );
}

function publishedMs(item: ScoredItem): number {
  const ms = Date.parse(item.publishedAt);
  return Number.isNaN(ms) ? 0 : ms;
}

/** Plain code-unit order, so the result does not depend on the machine's locale. */
function compareStrings(a: string, b: string): number {
  if (a === b) return 0;
  return a < b ? -1 : 1;
}

/**
 * Greedy pick from a ranked list. Areas under the slot cap compete on rank alone; once every
 * remaining item is in a full area, the least-filled area goes first, then rank.
 */
function pickWithAreaSpread(ranked: readonly Entry[], topN: number): Set<Entry> {
  const chosen = new Set<Entry>();
  const slotsByArea = new Map<string, number>();
  const areaOf = (entry: Entry): string => normalizeText(entry.item.classification.area);
  // Everything under the cap shares pressure 0, so rank decides among those.
  const pressure = (entry: Entry): number => {
    const used = slotsByArea.get(areaOf(entry)) ?? 0;
    return used < MAX_SLOTS_PER_AREA ? 0 : used;
  };

  while (chosen.size < Math.min(topN, ranked.length)) {
    const remaining = ranked.filter((entry) => !chosen.has(entry));
    const best = remaining.reduce((a, b) => (pressure(b) < pressure(a) ? b : a));
    chosen.add(best);
    slotsByArea.set(areaOf(best), (slotsByArea.get(areaOf(best)) ?? 0) + 1);
  }
  return chosen;
}
