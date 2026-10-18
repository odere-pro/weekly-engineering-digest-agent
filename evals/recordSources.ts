// `pnpm tsx evals/recordSources.ts`: saves the real response of every default source under
// evals/sources/<id>/ (W6-01). The bodies are untrusted data: they are written to disk as text
// and never executed. expected.json is written by hand and is never touched here.
import { realpathSync } from 'node:fs';
import { access, mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { format, resolveConfig } from 'prettier';
import { MAX_PAGE_BYTES, withoutElements } from '../src/sources/adapters/enrich';
import { getText, sameSiteAs, statusFailure, MAX_BODY_BYTES } from '../src/sources/adapters/http';
import { createFetcher, hostsOf } from '../src/sources/adapters/pipeline';
import { rssAdapter } from '../src/sources/adapters/rssAdapter';
import { DEFAULT_SOURCES } from '../src/sources/defaultSources';
import type { Source } from '../src/domain/schemas';
import { systemClock, type Clock } from '../src/shared/clock';
import { errorMessage } from '../src/shared/errors';
import type { SourceResponse } from './schema';
import { EVERYTHING, loadSourceRecordings, serveRecording } from './sourceEval';

export const RECORD_TIMEOUT_MS = 20_000;
const DEFAULT_OUT_DIR = fileURLToPath(new URL('./sources', import.meta.url));
const GITHUB_API_HOST = 'api.github.com';

export interface RecordSourcesOptions {
  /** Folder that gets one `<source id>/` folder per source. */
  outDir: string;
}

export interface RecordSourcesDeps {
  sources?: readonly Source[];
  fetch?: typeof fetch;
  clock?: Clock;
  /** One report line per call. Default: console.log. */
  log?: (line: string) => void;
}

export interface RecordSourcesResult {
  recorded: { sourceId: string; bytes: number }[];
  failed: { sourceId: string; error: string }[];
}

/** The URL the fetcher requests: a feed as it is, a repository through its releases feed. */
export function requestUrlFor(source: Source): string {
  return source.kind === 'github' ? `${source.url.replace(/\/+$/, '')}/releases.atom` : source.url;
}

const bodyFileFor = (contentType: string | null): string =>
  contentType?.toLowerCase().includes('json') ? 'body.json' : 'body.xml';

async function formatJson(path: string, value: unknown): Promise<string> {
  const options = await resolveConfig(path);
  return format(JSON.stringify(value), { ...options, filepath: path });
}

async function writeResponse(dir: string, response: SourceResponse): Promise<void> {
  const path = join(dir, 'response.json');
  await writeFile(path, await formatJson(path, response));
}

/** Replaces the source's old recording files; expected.json stays. */
async function resetFolder(dir: string): Promise<void> {
  await mkdir(dir, { recursive: true });
  await Promise.all(['body.xml', 'body.json'].map((name) => rm(join(dir, name), { force: true })));
}

async function hasRecordedBody(dir: string): Promise<boolean> {
  const found = await Promise.all(
    ['body.xml', 'body.json'].map((name) =>
      access(join(dir, name)).then(
        () => true,
        () => false,
      ),
    ),
  );
  return found.some(Boolean);
}

/**
 * Nothing is written until the answer is in, so a source that is down during a refresh keeps
 * its last good recording. Only a source with no recording yet gets an error-only response.json.
 */
async function recordOne(
  source: Source,
  folder: string,
  deps: Required<Pick<RecordSourcesDeps, 'fetch' | 'clock'>>,
): Promise<number> {
  const url = requestUrlFor(source);
  const fetchedAt = deps.clock.now().toISOString();
  let response: SourceResponse = { url, fetchedAt };
  try {
    const reply = await getText(url, {
      fetch: deps.fetch,
      label: source.id,
      allowsRedirectTo: sameSiteAs(source.url, GITHUB_API_HOST),
      signal: AbortSignal.timeout(RECORD_TIMEOUT_MS),
      maxBytes: MAX_BODY_BYTES,
    });
    const contentType = reply.headers.get('content-type');
    response = { ...response, status: reply.status, contentType };
    if (!reply.ok) throw statusFailure(reply.status, source.id);
    const bodyFile = bodyFileFor(contentType);
    await resetFolder(folder);
    await writeFile(join(folder, bodyFile), reply.body);
    await writeResponse(folder, { ...response, bodyFile });
    return Buffer.byteLength(reply.body);
  } catch (error) {
    if (!(await hasRecordedBody(folder))) {
      await mkdir(folder, { recursive: true });
      await writeResponse(folder, { ...response, error: errorMessage(error) });
    }
    throw error;
  }
}

/** One GET per source, one folder per source. A source that fails keeps its old recording, or is recorded with its error. */
export async function recordSources(
  options: RecordSourcesOptions,
  deps: RecordSourcesDeps = {},
): Promise<RecordSourcesResult> {
  const sources = deps.sources ?? DEFAULT_SOURCES;
  const log =
    deps.log ??
    ((line: string) => {
      console.log(line);
    });
  const shared = {
    fetch: deps.fetch ?? ((input, init) => globalThis.fetch(input, init)),
    clock: deps.clock ?? systemClock,
  };
  const result: RecordSourcesResult = { recorded: [], failed: [] };
  for (const source of sources) {
    try {
      const bytes = await recordOne(source, join(options.outDir, source.id), shared);
      result.recorded.push({ sourceId: source.id, bytes });
      log(`recorded ${source.id} (${bytes} bytes)`);
    } catch (error) {
      const message = errorMessage(error);
      result.failed.push({ sourceId: source.id, error: message });
      log(`FAILED ${source.id}: ${message}`);
    }
  }
  return result;
}

// --- Article pages ----------------------------------------------------------------------------

/** Pages in flight at once while recording; the same politeness as the fetcher. */
const PAGE_CONCURRENCY = 4;
/** Elements the article text never reads; dropping them keeps a recorded page small. */
const NOT_READ = new Set(['script', 'style', 'svg', 'nav', 'header', 'footer']);

/** An attribute value this long is hydration data, not text a reader sees. */
const LONG_ATTRIBUTE = /(\s[\w:-]+)=(?:"[^"]{1000,}"|'[^']{1000,}')/g;

/** A page as it is kept: without scripts, styles, SVG, site chrome and hydration attributes. */
export function compactPage(html: string): string {
  return withoutElements(html, NOT_READ).replace(LONG_ATTRIBUTE, '$1=""');
}

export interface RecordPagesResult {
  recorded: { sourceId: string; pages: number; bytes: number }[];
  failed: { sourceId: string; url: string; error: string }[];
}

interface MissingPage {
  id: string;
  url: string;
}

const pathExists = (path: string): Promise<boolean> =>
  access(path).then(
    () => true,
    () => false,
  );

/** The entries of a recorded feed that carry no text, as the pipeline reads them. */
async function entriesWithoutText(
  recording: Awaited<ReturnType<typeof loadSourceRecordings>>[number],
): Promise<MissingPage[]> {
  const fetcher = createFetcher(rssAdapter, { fetch: serveRecording(recording), enrich: false });
  const items = await fetcher.fetch(recording.source, EVERYTHING);
  return items.filter((item) => item.summary === '').map(({ id, url }) => ({ id, url }));
}

/**
 * The page of each entry whose feed has no body text, saved as `pages/<item id>.html.txt` (W6-02).
 * Only a page on the feed's own host is requested, through the same `http.ts` path as the
 * fetcher. A page already on disk is kept. Scripts, styles, SVG, site navigation and very long attributes are dropped before
 * saving: the article text never reads them and they are most of a modern page.
 */
export async function recordPages(
  options: RecordSourcesOptions,
  deps: RecordSourcesDeps = {},
): Promise<RecordPagesResult> {
  const sources = deps.sources ?? DEFAULT_SOURCES;
  const log =
    deps.log ??
    ((line: string) => {
      console.log(line);
    });
  const fetchImpl = deps.fetch ?? ((input, init) => globalThis.fetch(input, init));
  const result: RecordPagesResult = { recorded: [], failed: [] };

  for (const recording of await loadSourceRecordings(options.outDir, sources)) {
    if (recording.source.kind !== 'rss') continue;
    const { source } = recording;
    const dir = join(options.outDir, source.id, 'pages');
    const onSite = sameSiteAs(source.url);
    const queue = [...(await entriesWithoutText(recording))];
    let pages = 0;
    let bytes = 0;

    const worker = async (): Promise<void> => {
      for (let page = queue.shift(); page; page = queue.shift()) {
        const path = join(dir, `${page.id}.html.txt`);
        try {
          if (await pathExists(path)) continue;
          if (!onSite(new URL(page.url).hostname)) throw new Error('not on the feed host');
          const reply = await getText(page.url, {
            fetch: fetchImpl,
            label: source.id,
            allowsRedirectTo: sameSiteAs(source.url, ...hostsOf(sources)),
            signal: AbortSignal.timeout(RECORD_TIMEOUT_MS),
            maxBytes: MAX_PAGE_BYTES,
          });
          if (!reply.ok) throw statusFailure(reply.status, source.id);
          const html = compactPage(reply.body);
          await mkdir(dir, { recursive: true });
          await writeFile(path, html);
          pages += 1;
          bytes += Buffer.byteLength(html);
        } catch (error) {
          result.failed.push({ sourceId: source.id, url: page.url, error: errorMessage(error) });
          log(`FAILED ${page.url}: ${errorMessage(error)}`);
        }
      }
    };
    await Promise.all(Array.from({ length: PAGE_CONCURRENCY }, worker));
    result.recorded.push({ sourceId: source.id, pages, bytes });
    log(`recorded ${pages} pages of ${source.id} (${bytes} bytes)`);
  }
  return result;
}

// realpath: node resolves symlinks for the entry module, so argv[1] must be resolved the same way.
if (
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href
) {
  const run = process.argv.includes('--pages') ? recordPages : recordSources;
  run({ outDir: DEFAULT_OUT_DIR }).catch((error: unknown) => {
    console.error(`record sources failed: ${errorMessage(error)}`);
    process.exitCode = 1;
  });
}
