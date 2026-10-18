import { extractFromXml, type FeedEntry } from '@extractus/feed-extractor';
import type { Source } from '../../domain/schemas';
import { errorMessage } from '../../shared/errors';
import { textOf } from './feedFields';
import {
  GITHUB_API_HOST,
  GITHUB_HOST,
  githubUrl,
  httpError,
  parseDate,
  parseRepo,
  releaseEntry,
  type Repo,
} from './githubShared';
import { permanentFailure } from './http';
import type { RawEntry, SourceAdapter } from './pipeline';

// The releases.atom feed of a repository: no token, about the latest ten releases, and it does
// not flag prereleases.

const ATOM_NAMESPACE = 'http://www.w3.org/2005/Atom';
/** An empty feed holds a few metadata tags; `author/name` below `feed` is the deepest. */
const MAX_EMPTY_FEED_DEPTH = 3;

/**
 * A repository without releases serves a valid Atom feed with no `<entry>`, which the library
 * refuses as an unrecognized format. Rather than match its message, watch the tags the XML
 * parser reports: an Atom `<feed>` root and no `<entry>` below it means an empty feed. A
 * document that is not well-formed is rejected before any tag is reported, so it never looks
 * empty.
 */
function probeAtomShape(): {
  xmlParserOptions: Record<string, unknown>;
  isEmptyAtomFeed: () => boolean;
} {
  let hasAtomRoot = false;
  let entryCount = 0;
  let deepest = 0;
  const updateTag = (
    tagName: string,
    path: unknown,
    attributes: Record<string, string> | undefined,
  ): string => {
    if (typeof path === 'string') deepest = Math.max(deepest, path.split('.').length);
    if (path === 'feed') hasAtomRoot = attributes?.['@_xmlns'] === ATOM_NAMESPACE;
    else if (path === 'feed.entry') entryCount += 1;
    return tagName;
  };
  return {
    xmlParserOptions: { updateTag },
    // A parser that gave up on a deeply nested document stopped before it found an entry.
    isEmptyAtomFeed: () => hasAtomRoot && entryCount === 0 && deepest <= MAX_EMPTY_FEED_DEPTH,
  };
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

function toRawEntry(entry: FeedEntry, repo: Repo): RawEntry | undefined {
  const url = githubUrl(entry.link);
  const publishedAt = parseDate(entry.published);
  if (!url || !publishedAt) return undefined;
  const title = entry.title?.trim() ?? '';
  const html = typeof entry.html === 'string' ? entry.html : '';
  return releaseEntry(repo, {
    tag: tagFromReleaseUrl(url) ?? title,
    name: title,
    url,
    text: html,
    publishedAt,
  });
}

function parseAtom(xml: string, source: Source): RawEntry[] {
  const repo = parseRepo(source);
  const probe = probeAtomShape();
  let entries: FeedEntry[];
  try {
    entries =
      extractFromXml(xml, {
        descriptionMaxLen: 0,
        xmlParserOptions: probe.xmlParserOptions,
        // The library strips tags without spacing blocks apart; keep the raw HTML instead.
        getExtraEntryFields: (entry) => ({ html: textOf(entry.content) || textOf(entry.summary) }),
      }).entries ?? [];
  } catch (cause) {
    if (probe.isEmptyAtomFeed()) return [];
    throw permanentFailure(
      `Malformed releases feed for ${source.id}: ${errorMessage(cause)}`,
      cause,
    );
  }
  const releases = entries.flatMap((entry) => toRawEntry(entry, repo) ?? []);
  if (entries.length > 0 && releases.length === 0) {
    throw permanentFailure(
      `Unexpected releases feed for ${source.id}: no entry had a link and a date`,
    );
  }
  return releases;
}

export const githubAtomAdapter: SourceAdapter = {
  kind: 'github',
  // A release page is an app shell: it holds the notes the feed already has, or nothing.
  redirectHosts: [GITHUB_API_HOST],
  enrichable: false,

  async request(source, _window, get) {
    const repo = parseRepo(source);
    const reply = await get(`https://${GITHUB_HOST}/${repo.owner}/${repo.name}/releases.atom`);
    if (!reply.ok) throw httpError(reply, source);
    return [reply];
  },

  parse: (reply, source) => parseAtom(reply.body, source),
};
