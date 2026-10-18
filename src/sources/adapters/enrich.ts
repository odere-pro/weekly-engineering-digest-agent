import type { Source } from '../../domain/schemas';
import { errorMessage } from '../../shared/errors';
import type { Logger } from '../../shared/telemetry';
import { toPlainText, truncate } from '../../shared/text';
import { sameSiteAs } from './http';
import type { Get, RawEntry } from './pipeline';

// Some feeds carry no body text for some or all entries (Hugging Face, Node.js, parts of Google
// DeepMind and Mistral). For those entries the entry's own page is fetched and its first
// paragraphs are taken. The entry link must be on the feed's host; a redirect may lead to another
// host only if the caller's `get` allows it (the pipeline allows the collection allowlist).

/** A page larger than this is not an article worth reading. */
export const MAX_PAGE_BYTES = 2 * 1024 * 1024;
const DEFAULT_CONCURRENCY = 4;
/** The collect step gives a whole source 10 s, so the pages get less than that, together. */
const DEFAULT_BUDGET_MS = 4_000;
const DEFAULT_PAGE_TIMEOUT_MS = 3_000;
/** A longer meta tag is not read: attribute matching is quadratic in a tag's length. */
const MAX_META_TAG_CHARS = 2_000;
/** A paragraph shorter than this is a label or a date, not prose. */
const MIN_PARAGRAPH_CHARS = 25;
/** All the text of a container without paragraphs must be at least this much to count. */
const MIN_CONTAINER_CHARS = 40;
/** The summary is cut by the pipeline; the page text only has to be enough for it. */
const MAX_ARTICLE_CHARS = 1_200;
const MAX_LOGGED_ERROR_CHARS = 200;
const CONTAINERS = ['article', 'main'] as const;
const CHROME = new Set(['script', 'style', 'nav', 'header', 'footer']);
const RAW_TEXT = new Set(['script', 'style']);

const ANY_TAG = /<(\/?)([a-zA-Z][a-zA-Z0-9]*)(?:[\s/][^<>]*)?>/g;
const META_TAG = /<meta\b[^<>]*>/gi;
const ATTRIBUTE = /([a-zA-Z:_-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;

interface Span {
  /** Start of the content, just after the opening tag. */
  innerStart: number;
  innerEnd: number;
  /** Where scanning resumes: just after the closing tag. */
  next: number;
}

const isSelfClosing = (tag: string): boolean => tag.endsWith('/>');

/**
 * The element whose opening tag ends at `innerStart`. Same-name elements nest; script and style
 * end at the first closing tag. An element that never closes runs to the end of the page, as in
 * a browser. Each character is read once, forward.
 */
function spanOf(html: string, name: string, innerStart: number): Span {
  const pattern = new RegExp(`<(/?)${name}(?:[\\s/][^<>]*)?>`, 'gi');
  pattern.lastIndex = innerStart;
  const raw = RAW_TEXT.has(name);
  let depth = 1;
  for (let tag = pattern.exec(html); tag; tag = pattern.exec(html)) {
    const closes = tag[1] === '/';
    if (!closes && (raw || isSelfClosing(tag[0]))) continue;
    depth += closes ? -1 : 1;
    if (depth === 0) {
      return { innerStart, innerEnd: tag.index, next: tag.index + tag[0].length };
    }
  }
  return { innerStart, innerEnd: html.length, next: html.length };
}

/** `html` without the named elements, their content included. */
export function withoutElements(html: string, names: ReadonlySet<string>): string {
  const kept: string[] = [];
  let from = 0;
  const scan = new RegExp(ANY_TAG.source, 'g');
  for (;;) {
    scan.lastIndex = from;
    let tag = scan.exec(html);
    while (tag && (tag[1] === '/' || !names.has((tag[2] ?? '').toLowerCase()))) {
      tag = scan.exec(html);
    }
    if (!tag) return [...kept, html.slice(from)].join('');
    kept.push(html.slice(from, tag.index), ' ');
    from = isSelfClosing(tag[0])
      ? tag.index + tag[0].length
      : spanOf(html, (tag[2] ?? '').toLowerCase(), tag.index + tag[0].length).next;
  }
}

/** The content of each outermost element with this name, in page order. */
function innerHtmlOf(html: string, name: string): string[] {
  const opening = new RegExp(`<${name}(?:[\\s/][^<>]*)?>`, 'gi');
  const found: string[] = [];
  let from = 0;
  for (;;) {
    opening.lastIndex = from;
    const tag = opening.exec(html);
    if (!tag) return found;
    const span = isSelfClosing(tag[0])
      ? { innerStart: 0, innerEnd: 0, next: tag.index + tag[0].length }
      : spanOf(html, name, tag.index + tag[0].length);
    found.push(html.slice(span.innerStart, span.innerEnd));
    from = span.next;
  }
}

/** The first paragraphs of a container, or all its text when it has no real paragraph. */
function textOfContainer(inner: string): string {
  const paragraphs: string[] = [];
  let length = 0;
  for (const html of innerHtmlOf(inner, 'p')) {
    const text = toPlainText(html);
    if (text.length < MIN_PARAGRAPH_CHARS) continue;
    paragraphs.push(text);
    length += text.length;
    if (length >= MAX_ARTICLE_CHARS) break;
  }
  const joined = paragraphs.length > 0 ? paragraphs.join(' ') : toPlainText(inner);
  // A card title or a "Learn more" link is not a summary: the page's description is better.
  return joined.length < MIN_CONTAINER_CHARS ? '' : truncate(joined, MAX_ARTICLE_CHARS);
}

function metaDescription(html: string): string {
  const found = new Map<string, string>();
  for (const tag of html.match(META_TAG) ?? []) {
    if (tag.length > MAX_META_TAG_CHARS) continue;
    const attributes = new Map<string, string>();
    for (const [, key = '', double, single] of tag.matchAll(ATTRIBUTE)) {
      attributes.set(key.toLowerCase(), double ?? single ?? '');
    }
    const label = (attributes.get('property') ?? attributes.get('name') ?? '').toLowerCase();
    const content = attributes.get('content');
    if (content !== undefined && !found.has(label)) found.set(label, content);
  }
  return toPlainText(found.get('og:description') ?? found.get('description') ?? '');
}

/**
 * What a page says about itself: the first paragraphs of its first `<article>` or `<main>`
 * (site navigation, headers, footers, scripts and styles removed), else its description.
 */
export function articleText(html: string): string {
  const page = withoutElements(html, CHROME);
  for (const name of CONTAINERS) {
    for (const inner of innerHtmlOf(page, name)) {
      const text = textOfContainer(inner);
      if (text) return text;
    }
  }
  return metaDescription(page);
}

export interface EnrichDeps {
  get: Get;
  logger: Logger;
  signal?: AbortSignal | undefined;
  /** Pages in flight at once. */
  concurrency?: number;
  /** After this long no new page is started. */
  budgetMs?: number;
  pageTimeoutMs?: number;
  now?: () => number;
}

function pageSignal(outer: AbortSignal | undefined, timeoutMs: number): AbortSignal {
  const timeout = AbortSignal.timeout(timeoutMs);
  return outer ? AbortSignal.any([outer, timeout]) : timeout;
}

/** An answer that is clearly not markup is not read. */
function isWebPage(contentType: string | null): boolean {
  return contentType === null || /html|xml/i.test(contentType);
}

async function pageText(entry: RawEntry, deps: EnrichDeps, timeoutMs: number): Promise<string> {
  const reply = await deps.get(entry.url, {
    maxBytes: MAX_PAGE_BYTES,
    signal: pageSignal(deps.signal, timeoutMs),
  });
  if (!reply.ok || !isWebPage(reply.headers.get('content-type'))) return '';
  return articleText(reply.body);
}

/** The feed's host, protocol and port: a page on another port or over plain http is not read. */
function isOnFeedHost(
  entry: RawEntry,
  feedUrl: string,
  onSite: (hostname: string) => boolean,
): boolean {
  try {
    const page = new URL(entry.url);
    const feed = new URL(feedUrl);
    return onSite(page.hostname) && page.protocol === feed.protocol && page.port === feed.port;
  } catch {
    return false;
  }
}

/** A collect-step timeout or a cancelled run is not a page problem: let it through. */
function rethrowIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw signal.reason ?? new DOMException('aborted', 'AbortError');
}

/**
 * Entries whose text is empty get the text of their own page. Only a page on the feed's host
 * is requested. A page that fails, is slow or has no article text leaves its entry as it was,
 * with a debug line; it never fails the source. Returns new entries, same order.
 */
export async function enrichEntries(
  entries: readonly RawEntry[],
  source: Source,
  deps: EnrichDeps,
): Promise<RawEntry[]> {
  const onSite = sameSiteAs(source.url);
  const now = deps.now ?? Date.now;
  const startedAt = now();
  const budgetMs = deps.budgetMs ?? DEFAULT_BUDGET_MS;
  const result = [...entries];
  const wanted = entries.flatMap((entry, index) => (entry.text === '' ? [index] : []));
  let next = 0;

  const enrichOne = async (index: number): Promise<void> => {
    const entry = entries[index];
    if (!entry) return;
    if (!isOnFeedHost(entry, source.url, onSite)) {
      deps.logger.debug('Entry page is not on the feed host; not fetched', { sourceId: source.id });
      return;
    }
    try {
      const remaining = Math.max(1, budgetMs - (now() - startedAt));
      const text = await pageText(
        entry,
        deps,
        Math.min(deps.pageTimeoutMs ?? DEFAULT_PAGE_TIMEOUT_MS, remaining),
      );
      if (text) result[index] = { ...entry, text };
      else deps.logger.debug('Entry page had no article text', { sourceId: source.id });
    } catch (error) {
      rethrowIfAborted(deps.signal);
      deps.logger.debug('Entry page could not be read', {
        sourceId: source.id,
        error: truncate(errorMessage(error), MAX_LOGGED_ERROR_CHARS),
      });
    }
  };

  const worker = async (): Promise<void> => {
    for (let slot = next++; slot < wanted.length; slot = next++) {
      if (now() - startedAt >= budgetMs) {
        deps.logger.debug('Page budget spent; remaining entries keep their empty summary', {
          sourceId: source.id,
        });
        return;
      }
      await enrichOne(wanted[slot] as number);
    }
  };

  const workers = Math.min(deps.concurrency ?? DEFAULT_CONCURRENCY, wanted.length);
  await Promise.all(Array.from({ length: workers }, worker));
  return result;
}
