import { describe, expect, it } from 'vitest';
import { makeConfig, makeItem } from '../../../test/builders';
import { FakeModelProvider, noopLogger } from '../../../test/fakes';
import { tickingClock } from '../__fixtures__/rescoreKit';
import { classifyDeps, servedItems } from './replayInputs';

describe('servedItems', () => {
  const at = (id: string, sourceId: string, day: number) =>
    makeItem({ id, sourceId, publishedAt: `2026-10-0${day}T09:00:00Z` });

  it('serves a source newest first and cuts it at the global cap', () => {
    const config = makeConfig({ maxItemsPerSource: 2 });
    const feed = [
      at('old', 'example-feed', 1),
      at('new', 'example-feed', 3),
      at('mid', 'example-feed', 2),
    ];

    expect(servedItems(feed, config).map((item) => item.id)).toEqual(['new', 'mid']);
  });

  it('uses the source own cap before the global one', () => {
    const config = makeConfig({
      maxItemsPerSource: 5,
      sources: [{ id: 'small', kind: 'rss', url: 'https://example.com/a.xml', maxItems: 1 }],
    });
    const feed = [
      at('a1', 'small', 1),
      at('a2', 'small', 2),
      at('b1', 'other', 1),
      at('b2', 'other', 2),
    ];

    expect(servedItems(feed, config).map((item) => item.id)).toEqual(['a2', 'b2', 'b1']);
  });

  it('keeps the sources in the order they first appear', () => {
    const config = makeConfig();
    const feed = [at('b1', 'b', 1), at('a1', 'a', 1), at('b2', 'b', 2)];

    expect(servedItems(feed, config).map((item) => item.id)).toEqual(['b2', 'b1', 'a1']);
  });

  it('does not change its input', () => {
    const feed = [at('old', 'example-feed', 1), at('new', 'example-feed', 3)];

    servedItems(feed, makeConfig());

    expect(feed.map((item) => item.id)).toEqual(['old', 'new']);
  });

  it('serves nothing for no item', () => {
    expect(servedItems([], makeConfig())).toEqual([]);
  });
});

describe('classifyDeps', () => {
  const model = new FakeModelProvider({});
  const replayDeps = (config = makeConfig()) => ({
    model,
    config,
    logger: noopLogger,
    clock: tickingClock(),
  });

  it('reads the focus areas and the relevance floor from the config', () => {
    const config = makeConfig({ thresholds: { minRelevance: 2 } });

    const result = classifyDeps(replayDeps(config), false);

    expect(result).toMatchObject({
      model,
      focusAreas: config.focusAreas,
      logger: noopLogger,
      minRelevance: 2,
    });
  });

  it('passes the flag on as rescoreWithWriter', () => {
    expect(classifyDeps(replayDeps(), true).rescoreWithWriter).toBe(true);
    expect(classifyDeps(replayDeps(), false).rescoreWithWriter).toBe(false);
  });

  it('turns the area of a source into a hint', () => {
    const config = makeConfig({
      sources: [{ id: 'feed', kind: 'rss', url: 'https://example.com/a.xml', area: 'Security' }],
    });

    expect(classifyDeps(replayDeps(config), false).areaHints).toEqual(
      new Map([['feed', 'Security']]),
    );
  });
});
