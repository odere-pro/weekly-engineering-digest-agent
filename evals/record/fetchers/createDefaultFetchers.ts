import type { SourceKind } from '../../../src/domain/schemas';
import { createGithubReleasesFetcher } from '../../../src/sources/adapters/githubReleases';
import { createRssFetcher } from '../../../src/sources/adapters/rss';
import type { SourceFetcher } from '../../../src/sources/SourceFetcher';
import type { Logger } from '../../../src/shared/telemetry';

/** The real RSS and GitHub releases fetchers, both logging to `logger`. */
export function createDefaultFetchers(
  githubToken: string | undefined,
  logger: Logger,
): Record<SourceKind, SourceFetcher> {
  return {
    rss: createRssFetcher({ logger }),
    github: createGithubReleasesFetcher({ token: githubToken, logger }),
  };
}
