import { extractFromXml, type FeedEntry } from '@extractus/feed-extractor';
import { z } from 'zod';
import type { Item, Source } from '../../core/schemas.js';
import type { FetchWindow, SourceFetcher } from '../../ports/SourceFetcher.js';
import { errorMessage } from '../../shared/errors.js';
import { toPlainText, truncate } from '../../shared/text.js';
import { itemIdFor } from '../../shared/url.js';

export interface GithubReleasesOptions {
  fetch?: typeof fetch;
  /** Optional token: uses the REST API (5000 req/h) instead of the releases Atom feed. */
  token?: string;
  maxSummaryChars?: number;
}

const DEFAULT_MAX_SUMMARY_CHARS = 600;
const GITHUB_HOST = 'github.com';
const GITHUB_API = 'https://api.github.com';
const API_VERSION = '2022-11-28';
const API_PAGE_SIZE = 20;
const REDACTED = '[redacted]';
const OWNER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9-]*$/;
const REPO_PATTERN = /^(?!\.{1,2}$)(?!.*\.git$)[A-Za-z0-9._-]+$/;
const UNRECOGNIZED_FEED = 'Unrecognized feed format';
const ATOM_FEED_ROOT = /<feed\b[^>]*\bxmlns\s*=\s*["']http:\/\/www\.w3\.org\/2005\/Atom["']/;
const MARKDOWN_FENCE = /^```[^\n]*\n[\s\S]*?^```/gm;
const MARKDOWN_CODE_SPAN = /`[^`\n]*`/g;

interface Repo {
  owner: string;
  name: string;
}

/** A release from either transport, before it becomes an `Item`. */
interface Release {
  tag: string;
  name: string;
  url: string;
  /** Release notes as plain text, not yet truncated. */
  text: string;
  publishedAt: Date;
}

/** A fully read HTTP response. */
interface Reply {
  ok: boolean;
  status: number;
  headers: Headers;
  body: string;
}

type Get = (url: string, headers?: Record<string, string>) => Promise<Reply>;

const RestReleaseSchema = z.object({
  tag_name: z.string().min(1),
  name: z.string().nullish(),
  html_url: z.string(),
  body: z.string().nullish(),
  draft: z.boolean().default(false),
  prerelease: z.boolean().default(false),
  published_at: z.string().nullish(),
});
type RestRelease = z.infer<typeof RestReleaseSchema>;

/** GitHub releases for repositories on the allowlist (W1-02). */
export function createGithubReleasesFetcher(options: GithubReleasesOptions = {}): SourceFetcher {
  const fetchImpl = options.fetch ?? globalThis.fetch;
  const token = options.token?.trim() || undefined;
  const maxSummaryChars = options.maxSummaryChars ?? DEFAULT_MAX_SUMMARY_CHARS;

  return {
    kind: 'github',
    async fetch(source, window, signal) {
      const repo = parseRepo(source);
      const get: Get = (url, headers) => guardedGet(fetchImpl, url, { headers, signal }, token);
      const releases = token
        ? await fetchRestReleases(get, repo, source, token)
        : await fetchAtomReleases(get, repo, source);
      return selectInWindow(releases, window).map((release) =>
        toItem(release, source, repo, maxSummaryChars),
      );
    },
  };
}

function parseRepo(source: Source): Repo {
  // The URL is not echoed: config values may carry credentials.
  const invalid = (): never => {
    throw new Error(
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

  const [owner, name, ...rest] = url.pathname.replace(/^\/+|\/+$/g, '').split('/');
  const isRepoPath =
    rest.length === 0 && OWNER_PATTERN.test(owner ?? '') && REPO_PATTERN.test(name ?? '');
  return isRepoPath ? { owner: owner as string, name: name as string } : invalid();
}

/**
 * One GET with the body read in full. With a token, a failure is rebuilt from its message
 * alone (token redacted, no `cause`, no extra properties) so the secret cannot leak through a
 * thrown object; the error name survives so aborts and timeouts stay recognizable.
 */
async function guardedGet(
  fetchImpl: typeof fetch,
  url: string,
  init: RequestInit,
  token: string | undefined,
): Promise<Reply> {
  try {
    const response = await fetchImpl(url, init);
    const body = await response.text();
    return { ok: response.ok, status: response.status, headers: response.headers, body };
  } catch (error) {
    throw token ? redactedError(error, token) : error;
  }
}

function redactedError(error: unknown, token: string): Error {
  const safe = new Error(errorMessage(error).replaceAll(token, REDACTED));
  if (error instanceof Error) safe.name = error.name;
  return safe;
}

/**
 * The feed does not flag prereleases, so unlike the REST path it lists them too.
 * It also carries only the latest ~10 releases.
 */
async function fetchAtomReleases(get: Get, repo: Repo, source: Source): Promise<Release[]> {
  const reply = await get(`https://${GITHUB_HOST}/${repo.owner}/${repo.name}/releases.atom`);
  if (!reply.ok) throw httpError(reply, source);
  return parseAtom(reply.body, source);
}

async function fetchRestReleases(
  get: Get,
  repo: Repo,
  source: Source,
  token: string,
): Promise<Release[]> {
  const reply = await get(
    `${GITHUB_API}/repos/${repo.owner}/${repo.name}/releases?per_page=${API_PAGE_SIZE}`,
    {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': API_VERSION,
    },
  );
  if (!reply.ok) throw httpError(reply, source);

  const payload = parseJson(reply.body, source);
  if (!Array.isArray(payload)) {
    throw new Error(`Unexpected GitHub API response fetching ${source.id}: expected a list`);
  }
  const parsed = payload.map((raw: unknown) => RestReleaseSchema.safeParse(raw));
  if (parsed.length > 0 && parsed.every((result) => !result.success)) {
    throw new Error(`Unexpected GitHub API response fetching ${source.id}: no release matched`);
  }
  return parsed.flatMap((result) => (result.success ? (restRelease(result.data) ?? []) : []));
}

function parseJson(body: string, source: Source): unknown {
  try {
    return JSON.parse(body) as unknown;
  } catch {
    throw new Error(`Malformed GitHub API response fetching ${source.id}`);
  }
}

function httpError(reply: Reply, source: Source): Error {
  const { status, headers } = reply;
  const limited =
    (status === 403 || status === 429) &&
    (headers.get('x-ratelimit-remaining') === '0' || headers.has('retry-after'));
  if (!limited) return new Error(`HTTP ${status} fetching ${source.id}`);

  const resetAt = new Date(Number(headers.get('x-ratelimit-reset')) * 1000);
  const hasReset = !Number.isNaN(resetAt.getTime()) && resetAt.getTime() > 0;
  const resetsAt = hasReset ? `; resets at ${resetAt.toISOString()}` : '';
  return new Error(`GitHub rate limit hit fetching ${source.id} (HTTP ${status})${resetsAt}`);
}

function restRelease(raw: RestRelease): Release | undefined {
  if (raw.draft || raw.prerelease) return undefined;
  const url = githubUrl(raw.html_url);
  const publishedAt = parseDate(raw.published_at);
  if (!url || !publishedAt) return undefined;
  return {
    tag: raw.tag_name,
    name: raw.name ?? '',
    url,
    text: markdownToPlainText(raw.body ?? ''),
    publishedAt,
  };
}

function parseAtom(xml: string, source: Source): Release[] {
  let entries: FeedEntry[];
  try {
    const feed = extractFromXml(xml, {
      descriptionMaxLen: 0,
      // The library strips tags without spacing blocks apart; keep the raw HTML instead.
      getExtraEntryFields: (entry) => ({ html: textOf(entry.content) || textOf(entry.summary) }),
    });
    entries = feed.entries ?? [];
  } catch (cause) {
    if (isEmptyAtomFeed(cause, xml)) return [];
    throw new Error(`Malformed releases feed for ${source.id}: ${errorMessage(cause)}`, { cause });
  }
  const releases = entries.flatMap((entry) => atomRelease(entry) ?? []);
  if (entries.length > 0 && releases.length === 0) {
    throw new Error(`Unexpected releases feed for ${source.id}: no entry had a link and a date`);
  }
  return releases;
}

/**
 * A repository without releases serves a valid Atom feed with no `<entry>`, which the library
 * reports as an unrecognized format. Matching its exact message means a wording change fails
 * loudly (the source is listed as failed) instead of silently hiding a broken feed.
 */
function isEmptyAtomFeed(error: unknown, xml: string): boolean {
  return errorMessage(error) === UNRECOGNIZED_FEED && ATOM_FEED_ROOT.test(xml);
}

function atomRelease(entry: FeedEntry): Release | undefined {
  const url = githubUrl(entry.link);
  const publishedAt = parseDate(entry.published);
  if (!url || !publishedAt) return undefined;
  const title = entry.title?.trim() ?? '';
  const html = typeof entry.html === 'string' ? entry.html : '';
  return {
    tag: tagFromReleaseUrl(url) ?? title,
    name: title,
    url,
    text: toPlainText(html),
    publishedAt,
  };
}

/** Feed text is either a string or `{ '#text': string }` when the node has attributes. */
function textOf(node: unknown): string {
  if (typeof node === 'string') return node;
  if (typeof node === 'object' && node !== null && '#text' in node) {
    return typeof node['#text'] === 'string' ? node['#text'] : '';
  }
  return '';
}

function tagFromReleaseUrl(url: string): string | undefined {
  const encoded = /\/releases\/tag\/(.+)$/.exec(new URL(url).pathname)?.[1];
  if (!encoded) return undefined;
  try {
    return decodeURIComponent(encoded);
  } catch {
    return encoded;
  }
}

/** Release notes are Markdown: keep `<T>` inside code from being read as an HTML tag. */
function markdownToPlainText(markdown: string): string {
  const escapeAngles = (code: string): string =>
    code.replaceAll('<', '&lt;').replaceAll('>', '&gt;');
  return toPlainText(
    markdown.replace(MARKDOWN_FENCE, escapeAngles).replace(MARKDOWN_CODE_SPAN, escapeAngles),
  );
}

/** Release links must stay on github.com: they become the digest's allowed links. */
function githubUrl(raw: unknown): string | undefined {
  if (typeof raw !== 'string') return undefined;
  try {
    const url = new URL(raw);
    return url.protocol === 'https:' && url.hostname === GITHUB_HOST ? url.href : undefined;
  } catch {
    return undefined;
  }
}

function parseDate(raw: unknown): Date | undefined {
  if (typeof raw !== 'string') return undefined;
  const date = new Date(raw);
  return Number.isNaN(date.getTime()) ? undefined : date;
}

/** Inside `[since, until]`, newest first, at most `maxItems`. */
function selectInWindow(releases: readonly Release[], window: FetchWindow): Release[] {
  return releases
    .filter(
      ({ publishedAt }) =>
        publishedAt.getTime() >= window.since.getTime() &&
        publishedAt.getTime() <= window.until.getTime(),
    )
    .sort((a, b) => b.publishedAt.getTime() - a.publishedAt.getTime())
    .slice(0, window.maxItems);
}

function oneLine(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

function toItem(release: Release, source: Source, repo: Repo, maxSummaryChars: number): Item {
  const tag = oneLine(release.tag);
  const name = oneLine(release.name);
  return {
    id: itemIdFor(release.url),
    sourceId: source.id,
    kind: 'github',
    url: release.url,
    title: `${repo.name} ${name && name !== tag ? `${tag}: ${name}` : tag}`,
    summary: truncate(release.text, maxSummaryChars),
    publishedAt: release.publishedAt.toISOString(),
  };
}
