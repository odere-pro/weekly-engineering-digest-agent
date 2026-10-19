import { GuardsConfigSchema } from '../../../src/config/schema';
import type { DigestItem, Item } from '../../../src/domain/schemas';
import { GuardCheckIdSchema, type GuardCheckId } from '../../../src/guards/guardVerdict';
import { truncate } from '../../../src/shared/text';
import { missingFacts } from '../../../src/write/provenance/factTokens';
import { sampleLabels, type DigestSample } from './digestSample';
import { parseDigestMarkdown } from './parseDigest';
import { share } from '../measurement/numbers';
import { withByWeek, type CheckedWeek, type Measurement } from '../measurement/measurement';
import { noDigest, weekDetail } from '../measurement/weekDetail';

/** The parts of a shipped item the reader gets from the writer; the layout prints no other. */
const FACT_FIELDS = ['title', 'summary', 'action'] as const;
export type FactField = (typeof FACT_FIELDS)[number];

/** One version, advisory id or date in the digest that its own source does not have. */
export interface FactMiss {
  weekId: string;
  /** The title the digest gave the item. */
  itemTitle: string;
  field: FactField;
  /** The fact, normalised (`factTokensOf`). */
  token: string;
  /** The layers that read the digest and let this through, in the order they run. */
  passedBy: readonly string[];
}

/** One digest read against its sources. */
export interface WeekFacts {
  /** Shipped items whose link is a collected item. */
  checked: number;
  /** Of those, the ones with no missing fact. */
  clean: number;
  /** Shipped items left out: their link matches no collected item (`linkValidity` covers them). */
  skipped: number;
  misses: FactMiss[];
}

/** Code checks that read every draft; they run before the guards. */
const CODE_CHECKS: readonly string[] = ['linkCheck', 'formatCheck'];
/**
 * The output guards in the order `planGuards` runs them: the keys of the config's output checks.
 * The replay runs them in mode `any`, so a shipped digest was not flagged by any of them.
 */
const OUTPUT_GUARDS: readonly GuardCheckId[] = Object.keys(
  GuardsConfigSchema.parse({}).output.checks,
).map((id) => GuardCheckIdSchema.parse(id));

/**
 * A problem line quotes model text, so the title and the fact are cut. With the layers at the end
 * of the line (about 60 characters for four) the line stays under `MAX_PROBLEM_CHARS`, which
 * would otherwise cut the layers off.
 */
const MAX_TITLE_CHARS = 50;
const MAX_TOKEN_CHARS = 32;

const layersPassed = (disabledGuards: readonly GuardCheckId[]): string[] => [
  ...CODE_CHECKS,
  ...OUTPUT_GUARDS.filter((id) => !disabledGuards.includes(id)),
];

type FactBase = Pick<FactMiss, 'weekId' | 'passedBy'>;

function itemMisses(item: DigestItem, source: Item, base: FactBase): FactMiss[] {
  return FACT_FIELDS.flatMap((field) =>
    missingFacts(item[field] ?? '', source).map((token): FactMiss => ({
      ...base,
      itemTitle: item.title,
      field,
      token,
    })),
  );
}

/**
 * Reads the digest back from its Markdown and checks every version, CVE or GHSA id and ISO date
 * in each item's title, summary and action against the title and summary of the collected item
 * the link names.
 */
export function factsOfWeek(sample: DigestSample & { markdown: string }): WeekFacts {
  const sources = new Map(sample.items.map((item) => [item.id, item]));
  const base: FactBase = {
    weekId: sample.weekId,
    passedBy: layersPassed(sample.disabledGuards ?? []),
  };
  const shipped = parseDigestMarkdown(sample.markdown, sample.weekId, sample.items).items;
  const perItem = shipped.flatMap((item) => {
    const source = sources.get(item.itemId);
    return source === undefined ? [] : [itemMisses(item, source, base)];
  });
  return {
    checked: perItem.length,
    clean: perItem.filter((misses) => misses.length === 0).length,
    skipped: shipped.length - perItem.length,
    misses: perItem.flat(),
  };
}

const missLine = ({ field, itemTitle, token, passedBy }: FactMiss): string =>
  `${field} of "${truncate(itemTitle, MAX_TITLE_CHARS)}": ${truncate(token, MAX_TOKEN_CHARS)} ` +
  `is not in its source; got past ${passedBy.join(', ')}`;

const sum = (numbers: readonly number[]): number => numbers.reduce((total, n) => total + n, 0);

/** What the value leaves out: weeks with no digest and items with a link nobody collected. */
function skippedNote(noDigestLabels: readonly string[], skippedItems: number): string | undefined {
  const parts = [
    ...(noDigestLabels.length > 0 ? [`no digest in ${noDigestLabels.join(', ')}`] : []),
    ...(skippedItems > 0
      ? [
          `${skippedItems} ${skippedItems === 1 ? 'item' : 'items'} whose link matches no collected item`,
        ]
      : []),
  ];
  return parts.length === 0 ? undefined : `skipped: ${parts.join('; ')}`;
}

/**
 * Every version, CVE or GHSA id and date in the shipped digest is in the source it came from. The
 * value is the share of shipped items with no fact the source lacks. A week without a digest, and
 * an item whose link matches no collected item, are left out and named in the note. Each miss is
 * a problem line of its week: the part, the fact and the layers that let it through.
 */
export function factCarry(samples: readonly DigestSample[]): Measurement {
  const weeks = samples.map((sample) =>
    sample.markdown === undefined
      ? undefined
      : factsOfWeek({ ...sample, markdown: sample.markdown }),
  );
  const labels = sampleLabels(samples);
  const checked: CheckedWeek[] = samples.map((sample, index) => {
    const facts = weeks[index];
    return {
      label: labels[index] ?? sample.weekId,
      detail:
        facts === undefined
          ? noDigest(sample.cause)
          : weekDetail({ ok: facts.misses.length === 0, problems: facts.misses.map(missLine) }),
    };
  });
  const read = weeks.flatMap((facts) => facts ?? []);
  const note = skippedNote(
    checked.filter(({ detail }) => detail.status === 'no-digest').map(({ label }) => label),
    sum(read.map(({ skipped }) => skipped)),
  );
  const value = share(sum(read.map(({ clean }) => clean)), sum(read.map(({ checked: n }) => n)));
  return { ...withByWeek(value, checked), ...(note === undefined ? {} : { note }) };
}
