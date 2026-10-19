import { githubAtomAdapter } from '../../../sources/adapters/githubAtomAdapter';
import { createGithubRestAdapter } from '../../../sources/adapters/githubRestAdapter';
import { createFetcher } from '../../../sources/adapters/pipeline';
import { rssAdapter } from '../../../sources/adapters/rssAdapter';
import type { Secrets } from '../../../config/schema';
import type { SourceKind } from '../../../domain/schemas';
import type { SourceFetcher } from '../../../sources/SourceFetcher';
import type { Recorder } from './recorder';

/**
 * The fetchers of a run (same adapters, same pipeline) with the recorder's tap added, which a run
 * never has. The GitHub token picks the REST API over the Atom feed, as in the container.
 */
export function buildFetchers(
  secrets: Secrets,
  fetchImpl: typeof fetch,
  recorder: Recorder,
): Record<SourceKind, SourceFetcher> {
  const token = secrets.GITHUB_TOKEN?.trim();
  const { tap } = recorder;
  return {
    rss: createFetcher(rssAdapter, { fetch: fetchImpl, tap }),
    github: createFetcher(token ? createGithubRestAdapter(token) : githubAtomAdapter, {
      fetch: fetchImpl,
      tap,
    }),
  };
}
