import type { SourceFetcher } from '../../ports/SourceFetcher.js';
import { NotImplementedError } from '../../shared/errors.js';

export interface GithubReleasesOptions {
  fetch?: typeof fetch;
  /** Optional token: uses the REST API (5000 req/h) instead of the releases Atom feed. */
  token?: string;
  maxSummaryChars?: number;
}

/** GitHub releases for repositories on the allowlist (W1-02). */
export function createGithubReleasesFetcher(_options: GithubReleasesOptions = {}): SourceFetcher {
  throw new NotImplementedError('W1-02');
}
