import type { ScoredItem } from '../domain/schemas';
import type { Thresholds } from '../config/schema';
import { calibrateClassification, type Calibration } from './calibration';
import { DigestError } from '../shared/errors';
import { normalizeUrl } from '../shared/url';

export interface ProcessInput {
  items: readonly ScoredItem[];
  /** URLs already sent in recent weeks. */
  sentUrls: ReadonlySet<string>;
  thresholds: Thresholds;
  topN: number;
  /** When given, relevance is replaced by the calibrated score before filtering and ranking. */
  calibration?: Calibration | undefined;
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
  const { sentUrls, thresholds, topN, calibration } = input;
  assertTopN(topN);
  const items = calibration
    ? input.items.map((item) => ({
        ...item,
        classification: calibrateClassification(calibration, item.classification),
      }))
    : input.items;

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

/** Source ids that already have a kept entry for one story key. */
type SourcesByKey = Map<string, ReadonlySet<string>>;

/**
 * Entries that repeat a better-ranked one: same id, or, from a different source, the same
 * normalized title or the same release (product name plus version token in the title).
 * `survivors` is in rank order, so the first of each story is the one kept.
 */
function duplicates(survivors: readonly Entry[]): (entry: Entry) => boolean {
  const repeats = new Set<Entry>();
  const keptIds = new Set<string>();
  const byTitle: SourcesByKey = new Map();
  const byRelease: SourcesByKey = new Map();

  for (const entry of survivors) {
    const { id, sourceId, title } = entry.item;
    const titleKey = normalizeText(title);
    const releaseKey = releaseKeyOf(title);

    if (
      keptIds.has(id) ||
      repeatsFromOtherSource(byTitle, titleKey, sourceId) ||
      repeatsFromOtherSource(byRelease, releaseKey, sourceId)
    ) {
      repeats.add(entry);
      continue;
    }
    keptIds.add(id);
    rememberSource(byTitle, titleKey, sourceId);
    rememberSource(byRelease, releaseKey, sourceId);
  }
  return (entry) => repeats.has(entry);
}

/** A blank key never matches anything. */
function repeatsFromOtherSource(index: SourcesByKey, key: string, sourceId: string): boolean {
  const sources = key === '' ? undefined : index.get(key);
  return sources !== undefined && [...sources].some((source) => source !== sourceId);
}

function rememberSource(index: SourcesByKey, key: string, sourceId: string): void {
  if (key !== '') index.set(key, new Set(index.get(key)).add(sourceId));
}

/**
 * A dotted version in a title: `1.34`, `v5.20.0`, `2.1.5-rc1`. It must start and end at a word
 * edge, so `build1.2.3`, `1.2.3abc` and a bare `3` or `2026` never count.
 */
const VERSION_TOKEN = /(?<![\w.])v?(\d+(?:\.\d+)+(?:-[a-z0-9.]*[a-z0-9])?)(?!\w|\.\d)/;
const EVERY_VERSION_TOKEN = new RegExp(VERSION_TOKEN.source, 'g');
/** A subtitle after the version: "v1.34: Of Wind & Will", "2.0 - Fast Lane". */
const SUBTITLE = /^\s*(?::|[-\u2013\u2014]\s)/;
/** Words around a product name that are not part of it: "Announcing X", "X release 1.2". */
const LEADING_FILLER: ReadonlySet<string> = new Set(['announcing', 'introducing', 'new', 'the']);
const TRAILING_FILLER: ReadonlySet<string> = new Set([
  'release',
  'released',
  'version',
  'tag',
  'v',
]);
/**
 * First word after the version of a title that reports the release itself ("X 1.2 is out",
 * "X 1.2 on Platform"). A noun there ("X 1.2 Sonnet", "X 1.2 support in Y") names another product.
 */
const ANNOUNCEMENT_WORDS: ReadonlySet<string> = new Set([
  'is',
  'are',
  'was',
  'has',
  'have',
  'now',
  'just',
  'finally',
  'out',
  'live',
  'ga',
  'generally',
  'available',
  'released',
  'ships',
  'shipped',
  'arrives',
  'arrived',
  'lands',
  'landed',
  'launches',
  'launched',
  'announced',
  'adds',
  'brings',
  'introduces',
  'on',
  'in',
]);

/**
 * "product@version" for a title that only reports one release, else ''. The product is the words
 * before the first version token, minus filler. Two sources share a release only if both parts
 * are equal and the rest of each title is an announcement (see `announcesRelease`).
 * Deliberately narrow: a missed merge is left to the writer, a wrong merge drops real news.
 */
function releaseKeyOf(title: string): string {
  const folded = title.normalize('NFKC').toLowerCase();
  const match = VERSION_TOKEN.exec(folded);
  const rawVersion = match?.[1];
  if (match === null || rawVersion === undefined) return '';
  const version = canonicalVersion(rawVersion);
  const tail = folded.slice(match.index + match[0].length);
  if (!announcesRelease(tail, version, folded)) return '';
  const product = productName(folded.slice(0, match.index));
  return product === '' ? '' : `${product}@${version}`;
}

/**
 * True when what follows the version is nothing, a subtitle or an announcement phrase, and the
 * title names no other version. Anything else ("3.5 Haiku", "3.13 support in numpy", "1.2 vs 1.1")
 * is a different story that merely shares a prefix and a version.
 */
function announcesRelease(tail: string, version: string, title: string): boolean {
  const namesOtherVersion = [...title.matchAll(EVERY_VERSION_TOKEN)].some(
    ([, other]) => other !== undefined && canonicalVersion(other) !== version,
  );
  if (namesOtherVersion) return false;
  if (SUBTITLE.test(tail)) return true;
  const [firstWord = ''] = normalizeText(tail).split(' ');
  return firstWord === '' || ANNOUNCEMENT_WORDS.has(firstWord);
}

function productName(text: string): string {
  const words = normalizeText(text).split(' ').filter(Boolean);
  const first = words.findIndex((word) => !LEADING_FILLER.has(word));
  if (first === -1) return '';
  const last = words.findLastIndex((word) => !TRAILING_FILLER.has(word));
  return words.slice(first, last + 1).join(' ');
}

/** `0.12.0` and `0.12` are the same release; a prerelease suffix keeps its own identity. */
function canonicalVersion(version: string): string {
  if (version.includes('-')) return version;
  const parts = version.split('.');
  let end = parts.length;
  while (end > 2 && parts[end - 1] === '0') end -= 1;
  return parts.slice(0, end).join('.');
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
