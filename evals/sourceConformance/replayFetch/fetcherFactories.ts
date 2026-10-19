import { createGithubReleasesFetcher } from '../../../src/sources/adapters/githubReleases';
import { createRssFetcher } from '../../../src/sources/adapters/rss';
import type { SourceKind } from '../../../src/domain/schemas';
import type { SourceFetcher } from '../../../src/sources/SourceFetcher';

/** Builds the fetcher of a kind around a `fetch`; the recording's `fetch` is passed in. */
export type SourceFetcherFactories = Readonly<
  Record<SourceKind, (fetchImpl: typeof fetch) => SourceFetcher>
>;

export const defaultFetcherFactories: SourceFetcherFactories = {
  rss: (fetchImpl) => createRssFetcher({ fetch: fetchImpl }),
  github: (fetchImpl) => createGithubReleasesFetcher({ fetch: fetchImpl }),
};
