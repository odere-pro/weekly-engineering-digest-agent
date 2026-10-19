import { describe, expect, it, vi } from 'vitest';
import type { ScoredItem } from '../../classify/classification';
import type { Logger } from '../../shared/telemetry';
import type { WrittenItem } from '../writerSchema';
import { enforceProvenance, withSourceUrl } from './enforceProvenance';
import { makeScoredItem } from '../../../test/builders';
import { noopLogger } from '../../../test/fakes';

const EVIL_URL = 'https://evil.example/payload';

function makeSources(count = 3): ScoredItem[] {
  return Array.from({ length: count }, (_, i) => makeScoredItem({ title: `Tool ${i + 1}` }));
}

const indexed = (items: readonly ScoredItem[]): ReadonlyMap<string, ScoredItem> =>
  new Map(items.map((item) => [item.id, item]));

/** An item as the writer returned it, with `patch` over a complete one. */
function written(source: ScoredItem, patch: Partial<WrittenItem> = {}): WrittenItem {
  return {
    itemId: source.id,
    title: source.title,
    url: source.url,
    area: 'Platform engineering',
    summary: `What shipped in ${source.title}.`,
    whyItMatters: 'It changes how teams run software.',
    urgency: 'worth-a-look',
    action: 'Relevant if you run it.',
    ...patch,
  };
}

function spyLogger(): { logger: Logger; warn: ReturnType<typeof vi.fn> } {
  const warn = vi.fn();
  const logger: Logger = { ...noopLogger, warn, child: () => logger };
  return { logger, warn };
}

describe('enforceProvenance', () => {
  const sources = makeSources();
  const index = indexed(sources);

  it.each([
    ['an invented url', EVIL_URL],
    ['a url that only differs from the source in its path', `${sources[0]!.url}/../evil`],
    ['a url from another collected item', sources[1]!.url],
    ['no url', undefined],
    ['a null url', null],
    ['something that is not a url', 'javascript:alert(1)'],
  ])('replaces %s with the url of the source item', (_name, url) => {
    const [kept] = enforceProvenance([written(sources[0]!, { url })], index, noopLogger);

    expect(kept?.url).toBe(sources[0]!.url);
  });

  it('drops an item whose itemId is not a collected item, however plausible its url', () => {
    const { logger, warn } = spyLogger();
    const drafted = [
      written(sources[0]!),
      written(sources[1]!, { itemId: 'invented-id', url: sources[1]!.url }),
      written(sources[2]!),
    ];

    const kept = enforceProvenance(drafted, index, logger);

    expect(kept.map((item) => item.itemId)).toEqual([sources[0]!.id, sources[2]!.id]);
    expect(warn).toHaveBeenCalledWith('Removed digest item with unknown itemId', {
      itemId: 'invented-id',
    });
  });

  it('keeps only the first entry of an item the writer repeats, and says so', () => {
    const { logger, warn } = spyLogger();
    const drafted = [
      written(sources[0]!, { summary: 'First.' }),
      written(sources[1]!),
      written(sources[0]!, { summary: 'Second.' }),
    ];

    const kept = enforceProvenance(drafted, index, logger);

    expect(kept.map((item) => item.summary)).toEqual(['First.', `What shipped in Tool 2.`]);
    expect(warn).toHaveBeenCalledWith('Removed repeated digest item', { itemId: sources[0]!.id });
  });

  it('keeps the order the writer used', () => {
    const drafted = [written(sources[2]!), written(sources[0]!), written(sources[1]!)];

    const kept = enforceProvenance(drafted, index, noopLogger);

    expect(kept.map((item) => item.itemId)).toEqual([
      sources[2]!.id,
      sources[0]!.id,
      sources[1]!.id,
    ]);
  });

  it('cuts a long unknown itemId in the log line', () => {
    const { logger, warn } = spyLogger();
    const longId = 'x'.repeat(5_000);

    enforceProvenance([written(sources[0]!, { itemId: longId })], index, logger);

    const fields = warn.mock.calls[0]?.[1] as { itemId: string };
    expect(fields.itemId.startsWith('xxxx')).toBe(true);
    expect(fields.itemId.length).toBeLessThanOrEqual(80);
  });

  it('returns nothing for no items or no sources', () => {
    expect(enforceProvenance([], index, noopLogger)).toEqual([]);
    expect(enforceProvenance([written(sources[0]!)], new Map(), noopLogger)).toEqual([]);
  });

  it('only ever returns urls of the collected items', () => {
    const drafted = [
      written(sources[0]!, { url: EVIL_URL }),
      written(sources[1]!, { url: null }),
      written(sources[2]!, { url: `${sources[2]!.url}?x=1` }),
      written(sources[0]!, { itemId: 'x', url: sources[0]!.url }),
    ];

    const urls = enforceProvenance(drafted, index, noopLogger).map((item) => item.url);

    expect(urls).toHaveLength(3);
    for (const url of urls) expect(sources.map((source) => source.url)).toContain(url);
  });

  it('does not change the items it was given', () => {
    const drafted = [written(sources[0]!, { url: EVIL_URL, action: '  Do it  ' })];
    const snapshot = structuredClone(drafted);

    enforceProvenance(drafted, index, noopLogger);

    expect(drafted).toEqual(snapshot);
  });
});

describe('withSourceUrl', () => {
  const source = makeScoredItem();

  it('sets the source url and trims the action', () => {
    const item = withSourceUrl(
      written(source, { url: EVIL_URL, action: '  Upgrade now \n' }),
      source,
    );

    expect(item.url).toBe(source.url);
    expect(item.action).toBe('Upgrade now');
  });

  it.each(['', '   ', '\n\t'])('leaves the action out when it is %j', (action) => {
    const item = withSourceUrl(written(source, { action }), source);

    expect(item).not.toHaveProperty('action');
  });

  it('keeps urgency and every text field', () => {
    const item = withSourceUrl(written(source, { urgency: 'act-now' }), source);

    expect(item).toMatchObject({
      itemId: source.id,
      title: source.title,
      area: 'Platform engineering',
      urgency: 'act-now',
    });
  });
});
