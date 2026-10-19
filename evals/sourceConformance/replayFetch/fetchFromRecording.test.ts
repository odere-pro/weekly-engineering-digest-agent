import { describe, expect, it } from 'vitest';
import { FakeSourceFetcher } from '../../../test/fakes/FakeSourceFetcher';
import { feedA, goodItem, recording, repoB } from '../__fixtures__/conformanceKit';
import type { SourceFetcherFactories } from './fetcherFactories';
import { EVERYTHING, fetchFromRecording } from './fetchFromRecording';

describe('fetchFromRecording', () => {
  it('hands the fetcher a fetch that serves the recorded status, type and body', async () => {
    let seen: { status: number; type: string | null; body: string; url: string } | undefined;
    const factories: SourceFetcherFactories = {
      rss: (serve) => ({
        kind: 'rss',
        async fetch(source) {
          const response = await serve(source.url);
          seen = {
            status: response.status,
            type: response.headers.get('content-type'),
            body: await response.text(),
            url: source.url,
          };
          return [];
        },
      }),
      github: () => new FakeSourceFetcher('github', {}),
    };

    await fetchFromRecording(recording(feedA, []), factories);

    expect(seen).toEqual({
      status: 200,
      type: 'application/xml',
      body: '<rss/>',
      url: feedA.url,
    });
  });

  it('asks for a window that covers every entry and the largest cap', async () => {
    const fake = new FakeSourceFetcher('rss', {});
    await fetchFromRecording(recording(feedA, []), { rss: () => fake, github: () => fake });

    const { window } = fake.calls[0]!;
    expect(window.maxItems).toBe(100);
    expect(window.since.getTime()).toBeLessThanOrEqual(Date.parse('1990-01-01'));
    expect(window.until.getTime()).toBeGreaterThanOrEqual(Date.parse('2100-01-01'));
    expect(window).toEqual(EVERYTHING);
  });

  it('builds the fetcher of the recorded source kind and returns what it yields', async () => {
    const items = [goodItem('repo-b', 1)];
    const github = new FakeSourceFetcher('github', { 'repo-b': items });
    const rss = new FakeSourceFetcher('rss', {});

    const found = await fetchFromRecording(recording(repoB, items), {
      rss: () => rss,
      github: () => github,
    });

    expect(found).toEqual(items);
    expect(github.calls).toHaveLength(1);
    expect(rss.calls).toEqual([]);
  });
});
