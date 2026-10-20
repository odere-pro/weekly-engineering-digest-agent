import type { Source } from '../../domain/schemas';
import { FetchError } from '../../shared/errors';
import { permanentFailure, statusFailure, type Reply } from './http';
import type { RawEntry } from './entries/types';

// What the two GitHub transports (releases.atom and the REST API) have in common.

export const GITHUB_HOST = 'github.com';
export const GITHUB_API_HOST = 'api.github.com';

const OWNER_PATTERN = /^[a-z\d][a-z\d-]*$/i;
const REPO_PATTERN = /^(?!\.{1,2}$)(?!.*\.git$)[\w.-]+$/;

export interface Repo {
  owner: string;
  name: string;
}

/** The repository a source's URL names; the URL is not echoed, config values may carry secrets. */
export function parseRepo(source: Source): Repo {
  const invalid = (): never => {
    throw permanentFailure(
      `Source ${source.id} is not a GitHub repository URL ` +
        '(expected https://github.com/<owner>/<repo>)',
    );
  };
  let url: URL;
  try {
    url = new URL(source.url);
  } catch {
    return invalid();
  }
  const hasExtras = url.username || url.password || url.port || url.search || url.hash;
  if (url.protocol !== 'https:' || url.hostname !== GITHUB_HOST || hasExtras) return invalid();

  const [owner, name, ...rest] = url.pathname.replace(/^\/+|(?<!\/)\/+$/g, '').split('/');
  const isRepoPath =
    rest.length === 0 && OWNER_PATTERN.test(owner ?? '') && REPO_PATTERN.test(name ?? '');
  return isRepoPath ? { owner: owner as string, name: name as string } : invalid();
}

/**
 * A rate limit is not retried even on a 429: GitHub says to wait longer than the collect step's
 * back-off, and asking again while limited can lengthen the penalty.
 */
export function httpError(reply: Reply, source: Source): FetchError {
  const { status, headers } = reply;
  const limited =
    (status === 403 || status === 429) &&
    (headers.get('x-ratelimit-remaining') === '0' || headers.has('retry-after'));
  if (!limited) return statusFailure(status, source.id);

  const resetAt = new Date(Number(headers.get('x-ratelimit-reset')) * 1000);
  const hasReset = !Number.isNaN(resetAt.getTime()) && resetAt.getTime() > 0;
  const resetsAt = hasReset ? `; resets at ${resetAt.toISOString()}` : '';
  return new FetchError(`GitHub rate limit hit fetching ${source.id} (HTTP ${status})${resetsAt}`, {
    status,
    retryable: false,
  });
}

/** Release links must stay on github.com: they become the digest's allowed links. */
export function githubUrl(raw: unknown): string | undefined {
  if (typeof raw !== 'string') return undefined;
  try {
    const url = new URL(raw);
    return url.protocol === 'https:' && url.hostname === GITHUB_HOST ? url.href : undefined;
  } catch {
    return undefined;
  }
}

export function parseDate(raw: unknown): Date | undefined {
  if (typeof raw !== 'string') return undefined;
  const date = new Date(raw);
  return Number.isNaN(date.getTime()) ? undefined : date;
}

const oneLine = (text: string): string => text.replace(/\s+/g, ' ').trim();

/** `repo tag` or `repo tag: name`, on one line. */
function releaseTitle(repo: Repo, tag: string, name: string): string {
  const cleanTag = oneLine(tag);
  const cleanName = oneLine(name);
  return `${repo.name} ${cleanName && cleanName !== cleanTag ? `${cleanTag}: ${cleanName}` : cleanTag}`;
}

/** A release as a raw entry. The notes stay as markup; the pipeline makes them plain text. */
export function releaseEntry(
  repo: Repo,
  release: { tag: string; name: string; url: string; text: string; publishedAt: Date },
): RawEntry {
  return {
    url: release.url,
    title: releaseTitle(repo, release.tag, release.name),
    text: release.text,
    publishedAt: release.publishedAt,
  };
}
