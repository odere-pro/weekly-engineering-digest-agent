import { SourceSchema, type Source } from '../../../domain/schemas';
import { DigestError } from '../../../shared/errors';
import { printableLine } from '../../../shared/text';
import { normalizeUrl } from '../../../shared/url';
import { splitList } from '../../init/prompts/validate';
import type { RunPrompts } from './types';

const ID_MAX = 60;

/** `github` for `github.com/<owner>/<repo>` (releases feed); any other address is an RSS/Atom feed. */
export function detectKind(url: string): Source['kind'] {
  try {
    const { hostname, pathname } = new URL(url);
    const parts = pathname.split('/').filter((part) => part !== '');
    const onGithub = hostname === 'github.com' || hostname === 'www.github.com';
    return onGithub && parts.length === 2 ? 'github' : 'rss';
  } catch {
    return 'rss';
  }
}

/** An id from the host and path (`[a-z0-9-]`); `-2`, `-3`... when `taken` has it. */
export function sourceIdFor(url: string, taken: ReadonlySet<string>): string {
  let text = url;
  try {
    const parsed = new URL(url);
    text = `${parsed.hostname.replace(/^www\./, '')}${parsed.pathname}`;
  } catch {
    // Not a URL: slug the raw text.
  }
  const words = text
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((word) => word !== '');
  const slug = words.join('-').slice(0, ID_MAX).replace(/-$/, '');
  const base = slug === '' ? 'source' : slug;
  let id = base;
  for (let n = 2; taken.has(id); n++) id = `${base}-${String(n)}`;
  return id;
}

const isWebUrl = (text: string): boolean => /^https?:\/\/\S+$/i.test(text);

/** Comma-separated URLs as new sources, or the message to show. Checked with `SourceSchema`. */
export function parseSourceList(text: string, existing: readonly Source[]): Source[] | string {
  const urls = splitList(text);
  if (urls.length === 0) return 'Enter at least one URL';
  const takenIds = new Set(existing.map((source) => source.id));
  const knownUrls = new Set(existing.map((source) => normalizeUrl(source.url)));
  const added: Source[] = [];
  for (const url of urls) {
    const shown = printableLine(url);
    if (!isWebUrl(url)) return `"${shown}" is not an http(s) URL`;
    if (knownUrls.has(normalizeUrl(url))) return `"${shown}" is already a source`;
    const id = sourceIdFor(url, takenIds);
    const parsed = SourceSchema.safeParse({ id, kind: detectKind(url), url });
    if (!parsed.success) return `"${shown}" is not a valid source URL`;
    takenIds.add(id);
    knownUrls.add(normalizeUrl(url));
    added.push(parsed.data);
  }
  return added;
}

/** The sources a `--add-source` flag names; a bad one stops the run before anything is fetched. */
export function sourcesOrThrow(text: string, existing: readonly Source[]): Source[] {
  const parsed = parseSourceList(text, existing);
  if (typeof parsed === 'string') throw new DigestError(`Invalid --add-source: ${parsed}.`);
  return parsed;
}

/** Asks for the URLs; the prompt refuses what `parseSourceList` refuses. */
export async function askNewSources(
  prompts: RunPrompts,
  existing: readonly Source[],
): Promise<Source[]> {
  const text = await prompts.input({
    message: 'Source URLs (comma-separated)',
    validate: (value) => {
      const parsed = parseSourceList(value, existing);
      return typeof parsed === 'string' ? parsed : true;
    },
  });
  return sourcesOrThrow(text, existing);
}
