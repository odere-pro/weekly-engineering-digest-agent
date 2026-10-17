import { FetchError } from '../../shared/errors.js';

/** A feed or API body larger than this fails the source: no real feed comes close. */
export const MAX_BODY_BYTES = 5 * 1024 * 1024;

const BYTES_PER_MIB = 1024 * 1024;
const MAX_REDIRECTS = 5;
const REDIRECT_STATUSES: ReadonlySet<number> = new Set([301, 302, 303, 307, 308]);
const REQUEST_TIMEOUT_STATUS = 408;
const TOO_MANY_REQUESTS_STATUS = 429;
const FIRST_SERVER_ERROR_STATUS = 500;
/** The only caller headers another origin may receive: nothing that identifies the caller. */
const SHAREABLE_HEADERS: ReadonlySet<string> = new Set(['accept', 'x-github-api-version']);

/** A fully read HTTP response. `body` is empty unless the answer was a 2xx. */
export interface Reply {
  ok: boolean;
  status: number;
  headers: Headers;
  body: string;
}

export interface GetOptions {
  fetch: typeof fetch;
  /** The source id, named in every error. */
  label: string;
  /** Whether a redirect may lead to this hostname. See `sameSiteAs`. */
  allowsRedirectTo: (hostname: string) => boolean;
  headers?: Record<string, string> | undefined;
  signal?: AbortSignal | undefined;
  /** Defaults to `MAX_BODY_BYTES`. */
  maxBytes?: number;
}

/** Timeouts, rate limits and server errors can clear up on their own; other 4xx cannot. */
export function isRetryableStatus(status: number): boolean {
  return (
    status >= FIRST_SERVER_ERROR_STATUS ||
    status === REQUEST_TIMEOUT_STATUS ||
    status === TOO_MANY_REQUESTS_STATUS
  );
}

/** A non-2xx answer; the collect step retries it when `isRetryableStatus` says so. */
export function statusFailure(status: number, label: string): FetchError {
  return new FetchError(`HTTP ${status} fetching ${label}`, {
    status,
    retryable: isRetryableStatus(status),
  });
}

/** A failure another attempt will not fix: a bad URL or feed, a refused redirect, a huge body. */
export function permanentFailure(message: string, cause?: unknown): FetchError {
  return new FetchError(message, { retryable: false, cause });
}

const withoutWww = (hostname: string): string => hostname.toLowerCase().replace(/^www\./, '');

function homeHost(sourceUrl: string): string | undefined {
  try {
    return withoutWww(new URL(sourceUrl).hostname);
  } catch {
    return undefined; // `getText` refuses the URL itself, with a clearer error
  }
}

/**
 * The hosts a redirect may reach: the source's own host (the apex and its `www.` count as one)
 * plus any `extraHosts` the caller names, such as `api.github.com` for GitHub sources.
 */
export function sameSiteAs(
  sourceUrl: string,
  ...extraHosts: readonly string[]
): (hostname: string) => boolean {
  const home = homeHost(sourceUrl);
  const extras = new Set(extraHosts.map((host) => host.toLowerCase()));
  return (hostname) => withoutWww(hostname) === home || extras.has(hostname.toLowerCase());
}

/**
 * One GET with the body read in full. Redirects are followed here, by hand, and only to hosts
 * the caller allows (network allowlist, spec invariant 4); credentials are not sent to another
 * origin. The body is capped, so a hostile or broken server cannot fill memory.
 */
export async function getText(url: string, options: GetOptions): Promise<Reply> {
  const start = parseHttpUrl(url, options.label);
  let current = url;
  for (let redirects = 0; ; redirects++) {
    const response = await options.fetch(current, {
      headers: headersFor(options.headers, new URL(current).origin === start.origin),
      signal: options.signal,
      redirect: 'manual',
    });
    if (!REDIRECT_STATUSES.has(response.status)) return readReply(response, options);

    await discardBody(response);
    if (redirects >= MAX_REDIRECTS) {
      throw permanentFailure(`Too many redirects fetching ${options.label}`);
    }
    current = redirectTarget(response, current, start, options);
  }
}

function parseHttpUrl(raw: string, label: string): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw permanentFailure(`The URL of ${label} is not valid`);
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw permanentFailure(`The URL of ${label} is not an http(s) URL`);
  }
  // The config schema rejects these too. Real `fetch` would refuse the URL with an error that
  // echoes it, password included, into failedSources and the logs.
  if (url.username || url.password) {
    throw permanentFailure(`The URL of ${label} contains a username or password`);
  }
  return url;
}

/** Only the start origin gets the caller's headers in full: a token must not travel on. */
function headersFor(
  headers: Record<string, string> | undefined,
  isStartOrigin: boolean,
): Record<string, string> | undefined {
  if (headers === undefined || isStartOrigin) return headers;
  return Object.fromEntries(
    Object.entries(headers).filter(([name]) => SHAREABLE_HEADERS.has(name.toLowerCase())),
  );
}

/** The next URL to request, or a failure naming only the host that was refused. */
function redirectTarget(response: Response, from: string, start: URL, options: GetOptions): string {
  const { label } = options;
  const location = response.headers.get('location');
  if (!location) throw permanentFailure(`Redirect without a location fetching ${label}`);

  let target: URL;
  try {
    target = new URL(location, from);
  } catch {
    throw permanentFailure(`Redirect to an invalid location fetching ${label}`);
  }
  if (target.protocol !== 'http:' && target.protocol !== 'https:') {
    throw permanentFailure(`Redirect to a non-http(s) URL fetching ${label}`);
  }
  if (target.username || target.password) {
    throw permanentFailure(`Redirect to a URL with credentials fetching ${label}; not followed`);
  }
  if (new URL(from).protocol === 'https:' && target.protocol === 'http:') {
    throw permanentFailure(`Redirect from https to http fetching ${label}; not followed`);
  }
  if (target.port !== start.port) {
    throw permanentFailure(`Redirect to another port fetching ${label}; not followed`);
  }
  if (!options.allowsRedirectTo(target.hostname)) {
    throw permanentFailure(
      `${label} redirected to ${target.hostname}, which is not its own host; not followed`,
    );
  }
  return target.href;
}

async function readReply(response: Response, options: GetOptions): Promise<Reply> {
  const { ok, status, headers } = response;
  if (!ok) {
    await discardBody(response);
    return { ok, status, headers, body: '' };
  }
  return { ok, status, headers, body: await readCapped(response, options) };
}

async function readCapped(response: Response, options: GetOptions): Promise<string> {
  const maxBytes = options.maxBytes ?? MAX_BODY_BYTES;
  const tooLarge = (): FetchError =>
    permanentFailure(
      `The feed of ${options.label} is larger than ${Math.round(maxBytes / BYTES_PER_MIB)} MiB`,
    );

  if (Number(response.headers.get('content-length')) > maxBytes) {
    await discardBody(response);
    throw tooLarge();
  }
  const reader: ReadableStreamDefaultReader<Uint8Array> | undefined = response.body?.getReader();
  if (!reader) return '';

  const chunks: Uint8Array[] = [];
  let received = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    received += value.byteLength;
    if (received > maxBytes) {
      await reader.cancel().catch(() => undefined);
      throw tooLarge();
    }
    chunks.push(value);
  }
  return new TextDecoder().decode(Buffer.concat(chunks));
}

/** Frees the connection of an answer whose body is not wanted. */
async function discardBody(response: Response): Promise<void> {
  await response.body?.cancel().catch(() => undefined);
}
