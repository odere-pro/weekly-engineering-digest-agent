import type { SourceFetcher } from '../SourceFetcher';
import type { Logger } from '../../shared/telemetry';
import { githubAtomAdapter } from './githubAtomAdapter';
import { createGithubRestAdapter } from './githubRestAdapter';
import { createFetcher } from './pipeline';

export interface GithubReleasesOptions {
  fetch?: typeof fetch;
  /** Optional token: uses the REST API (5000 req/h) instead of the releases Atom feed. */
  token?: string;
  maxSummaryChars?: number;
  /** Where a release that had to be skipped is reported, once per source (W5-01, F18). */
  logger?: Logger;
}

/** GitHub releases for repositories on the allowlist (W1-02). */
export function createGithubReleasesFetcher(options: GithubReleasesOptions = {}): SourceFetcher {
  const token = options.token?.trim() || undefined;
  const adapter = token ? createGithubRestAdapter(token) : githubAtomAdapter;
  return createFetcher(adapter, {
    ...(options.fetch ? { fetch: options.fetch } : {}),
    ...(options.maxSummaryChars === undefined ? {} : { maxSummaryChars: options.maxSummaryChars }),
    ...(options.logger ? { logger: options.logger } : {}),
  });
}
