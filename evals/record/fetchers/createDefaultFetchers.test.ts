import { describe, expect, it, vi } from 'vitest';
import { createGithubReleasesFetcher } from '../../../src/sources/adapters/githubReleases';
import { createRssFetcher } from '../../../src/sources/adapters/rss';
import { noopLogger } from '../../../src/shared/telemetry';
import { createDefaultFetchers } from './createDefaultFetchers';

// The real factories with a spy on each: the test sees the options they were given.
vi.mock('../../../src/sources/adapters/rss', async (importOriginal) => {
  const actual = await importOriginal<{ createRssFetcher: typeof createRssFetcher }>();
  return { ...actual, createRssFetcher: vi.fn(actual.createRssFetcher) };
});
vi.mock('../../../src/sources/adapters/githubReleases', async (importOriginal) => {
  const actual = await importOriginal<{
    createGithubReleasesFetcher: typeof createGithubReleasesFetcher;
  }>();
  return { ...actual, createGithubReleasesFetcher: vi.fn(actual.createGithubReleasesFetcher) };
});

describe('createDefaultFetchers', () => {
  it('builds the RSS fetcher and the GitHub releases fetcher', () => {
    const fetchers = createDefaultFetchers(undefined, noopLogger);

    expect(Object.keys(fetchers).toSorted()).toEqual(['github', 'rss']);
    expect(fetchers.rss.kind).toBe('rss');
    expect(fetchers.github.kind).toBe('github');
  });

  it('gives the RSS fetcher the logger and the GitHub fetcher the token and the logger', () => {
    createDefaultFetchers('ghp_example', noopLogger);

    expect(createRssFetcher).toHaveBeenLastCalledWith({ logger: noopLogger });
    expect(createGithubReleasesFetcher).toHaveBeenLastCalledWith({
      token: 'ghp_example',
      logger: noopLogger,
    });
  });

  it('passes no token when the environment has none', () => {
    createDefaultFetchers(undefined, noopLogger);

    expect(createGithubReleasesFetcher).toHaveBeenLastCalledWith({
      token: undefined,
      logger: noopLogger,
    });
  });
});
