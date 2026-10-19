import { describe, expect, it } from 'vitest';
import { defaultFetcherFactories } from './fetcherFactories';

describe('defaultFetcherFactories', () => {
  it('builds the real fetcher of each source kind', () => {
    const noNetwork: typeof fetch = () => Promise.reject(new Error('no network in this test'));

    expect(defaultFetcherFactories.rss(noNetwork).kind).toBe('rss');
    expect(defaultFetcherFactories.github(noNetwork).kind).toBe('github');
  });

  it('has a factory for exactly the two source kinds', () => {
    expect(Object.keys(defaultFetcherFactories).toSorted()).toEqual(['github', 'rss']);
  });
});
