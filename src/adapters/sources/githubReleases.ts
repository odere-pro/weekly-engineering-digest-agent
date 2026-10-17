import type { SourceFetcher } from '../../ports/SourceFetcher.js';
import { githubAtomAdapter } from './githubAtomAdapter.js';
import { createGithubRestAdapter } from './githubRestAdapter.js';
import { createFetcher } from './pipeline.js';

export interface GithubReleasesOptions {
  fetch?: typeof fetch;
  /** Optional token: uses the REST API (5000 req/h) instead of the releases Atom feed. */
  token?: string;
  maxSummaryChars?: number;
}

/** GitHub releases for repositories on the allowlist (W1-02). */
export function createGithubReleasesFetcher(options: GithubReleasesOptions = {}): SourceFetcher {
  const token = options.token?.trim() || undefined;
  const adapter = token ? createGithubRestAdapter(token) : githubAtomAdapter;
  return createFetcher(adapter, {
    ...(options.fetch ? { fetch: options.fetch } : {}),
    ...(options.maxSummaryChars === undefined ? {} : { maxSummaryChars: options.maxSummaryChars }),
  });
}
