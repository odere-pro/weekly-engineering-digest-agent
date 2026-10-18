import { z } from 'zod';
import type { Source } from '../../domain/schemas';
import { errorMessage, FetchError } from '../../shared/errors';
import {
  GITHUB_API_HOST,
  githubUrl,
  httpError,
  parseDate,
  parseRepo,
  releaseEntry,
} from './githubShared';
import { permanentFailure, type Reply } from './http';
import type { Get, RawEntry, SourceAdapter } from './pipeline';

// The REST API of a repository's releases, used when a token is configured (5000 requests an
// hour instead of the feed's anonymous limit). Prereleases and drafts are left out.

const GITHUB_API = `https://${GITHUB_API_HOST}`;
const API_VERSION = '2022-11-28';
const API_PAGE_SIZE = 20;
const REDACTED = '[redacted]';
const MARKDOWN_FENCE = /^```[^\n]*\n[\s\S]*?^```/gm;
const MARKDOWN_CODE_SPAN = /`[^`\n]*`/g;

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

/**
 * With a token, a failure from the network is rebuilt from its message alone (token redacted,
 * no `cause`, no extra properties) so the secret cannot leak through a thrown object; the error
 * name survives so aborts and timeouts stay recognizable. Our own `FetchError`s name only the
 * source and a host, so they pass through with their type, which the collect step needs to
 * decide on a retry.
 */
async function guarded(get: Get, token: string, url: string, headers: Record<string, string>) {
  try {
    return await get(url, { headers });
  } catch (error) {
    throw error instanceof FetchError ? error : redactedError(error, token);
  }
}

function redactedError(error: unknown, token: string): Error {
  const safe = new Error(errorMessage(error).replaceAll(token, REDACTED));
  if (error instanceof Error) safe.name = error.name;
  return safe;
}

/** Release notes are Markdown: keep `<T>` inside code from being read as an HTML tag. */
function escapedMarkdown(markdown: string): string {
  const escapeAngles = (code: string): string =>
    code.replaceAll('<', '&lt;').replaceAll('>', '&gt;');
  return markdown.replace(MARKDOWN_FENCE, escapeAngles).replace(MARKDOWN_CODE_SPAN, escapeAngles);
}

function parseJson(body: string, source: Source): unknown {
  try {
    return JSON.parse(body) as unknown;
  } catch {
    throw permanentFailure(`Malformed GitHub API response fetching ${source.id}`);
  }
}

function toRawEntry(raw: RestRelease, source: Source): RawEntry | undefined {
  if (raw.draft || raw.prerelease) return undefined;
  const url = githubUrl(raw.html_url);
  const publishedAt = parseDate(raw.published_at);
  if (!url || !publishedAt) return undefined;
  return releaseEntry(parseRepo(source), {
    tag: raw.tag_name,
    name: raw.name ?? '',
    url,
    text: escapedMarkdown(raw.body ?? ''),
    publishedAt,
  });
}

function parseReleases(reply: Reply, source: Source): RawEntry[] {
  const payload = parseJson(reply.body, source);
  if (!Array.isArray(payload)) {
    throw permanentFailure(`Unexpected GitHub API response fetching ${source.id}: expected a list`);
  }
  const parsed = payload.map((raw: unknown) => RestReleaseSchema.safeParse(raw));
  if (parsed.length > 0 && parsed.every((result) => !result.success)) {
    throw permanentFailure(
      `Unexpected GitHub API response fetching ${source.id}: no release matched`,
    );
  }
  return parsed.flatMap((result) =>
    result.success ? (toRawEntry(result.data, source) ?? []) : [],
  );
}

export function createGithubRestAdapter(token: string): SourceAdapter {
  return {
    kind: 'github',
    redirectHosts: [GITHUB_API_HOST],
    enrichable: false,

    async request(source, _window, get) {
      const repo = parseRepo(source);
      const reply = await guarded(
        get,
        token,
        `${GITHUB_API}/repos/${repo.owner}/${repo.name}/releases?per_page=${API_PAGE_SIZE}`,
        {
          Authorization: `Bearer ${token}`,
          Accept: 'application/vnd.github+json',
          'X-GitHub-Api-Version': API_VERSION,
        },
      );
      if (!reply.ok) throw httpError(reply, source);
      return [reply];
    },

    parse: parseReleases,
  };
}
