import type { LoadedConfig } from '../../../config/load';
import type { Source, SourceKind } from '../../../domain/schemas';
import { createGithubReleasesFetcher } from '../../../sources/adapters/githubReleases';
import { createRssFetcher } from '../../../sources/adapters/rss';
import type { SourceFetcher } from '../../../sources/SourceFetcher';
import { errorMessage } from '../../../shared/errors';
import { withTimeout } from '../../../shared/retry';
import type { DoctorIo } from '../types';
import { ok, warn, type CheckResult } from '../report/checkResult';

/** How long one source may take to answer. A slow source is a warning, not a failure. */
export const SOURCE_TIMEOUT_MS = 10_000;
const ONE_DAY_MS = 86_400_000;

export type SourceIo = Pick<DoctorIo, 'fetch' | 'clock' | 'sourceTimeoutMs'>;

/** Reads one item from every source, in parallel, through the real fetchers. Results keep config order. */
export async function checkSources(
  loaded: Pick<LoadedConfig, 'config' | 'secrets'>,
  io: SourceIo,
): Promise<CheckResult[]> {
  const fetchers: Record<SourceKind, SourceFetcher> = {
    rss: createRssFetcher({ fetch: io.fetch }),
    github: createGithubReleasesFetcher({ fetch: io.fetch, token: loaded.secrets.GITHUB_TOKEN }),
  };
  return Promise.all(loaded.config.sources.map((source) => checkSource(source, fetchers, io)));
}

export async function checkSource(
  source: Source,
  fetchers: Readonly<Record<SourceKind, SourceFetcher>>,
  io: Pick<SourceIo, 'clock' | 'sourceTimeoutMs'>,
): Promise<CheckResult> {
  const label = `source ${source.id}`;
  const until = io.clock.now();
  const window = { since: new Date(until.getTime() - ONE_DAY_MS), until, maxItems: 1 };
  try {
    await withTimeout(
      (signal) => fetchers[source.kind].fetch(source, window, signal),
      io.sourceTimeoutMs,
    );
    return ok(label, 'reachable and readable');
  } catch (error) {
    return warn(
      label,
      errorMessage(error),
      'check the URL, or remove the source from digest.config.json (a run skips it)',
    );
  }
}
