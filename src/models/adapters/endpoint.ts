// The configured Ollama address (`OLLAMA_URL`): where requests go, and what must never be printed.
// A password in the URL is moved into a Basic authorization header, so no request URL, error
// message, log line or run record can carry it. Pure string work; no fetch here.

/** `scheme://` (or `//`, or nothing), then everything up to the last `@` of the authority. */
const USERINFO = /^((?:[a-z][a-z\d+.-]*:)?\/\/)?([^/?#]*)@/i;
const HTTP_SCHEME = /^https?:\/\//i;
const TRAILING_SLASHES = /\/+$/;

export interface Endpoint {
  /** The base URL requests are sent to: no credentials, no trailing slash. */
  readonly root: string;
  /** `Basic <base64>` for the credentials the URL carried; undefined when it carried none. */
  readonly authorization: string | undefined;
}

interface UrlParts {
  /** The URL without its `user:password@`. */
  readonly bare: string;
  readonly user: string;
  readonly password: string;
}

function decode(text: string): string {
  try {
    return decodeURIComponent(text);
  } catch {
    // A stray "%": the text was never percent-encoded, so it is what the user typed.
    return text;
  }
}

/** Works on a string, not a `URL`, so a URL that does not parse still loses its credentials. */
function splitUserinfo(url: string): UrlParts | undefined {
  const match = USERINFO.exec(url);
  if (match === null) return undefined;
  const userinfo = match[2] ?? '';
  const colon = userinfo.indexOf(':');
  return {
    bare: `${match[1] ?? ''}${url.slice(match[0].length)}`,
    user: colon < 0 ? userinfo : userinfo.slice(0, colon),
    password: colon < 0 ? '' : userinfo.slice(colon + 1),
  };
}

/**
 * Reads the base URL once. Credentials are cut out of `root` and sent as Basic authorization
 * instead, decoded first: Node's `fetch` refuses a URL with credentials and quotes the whole URL
 * in its error.
 */
export function parseEndpoint(baseUrl: string): Endpoint {
  const trimmed = baseUrl.trim().replace(TRAILING_SLASHES, '');
  const parts = splitUserinfo(trimmed);
  if (parts === undefined) return { root: trimmed, authorization: undefined };
  const { bare, user, password } = parts;
  if (user === '' && password === '') return { root: bare, authorization: undefined };
  const credentials = Buffer.from(`${decode(user)}:${decode(password)}`).toString('base64');
  return { root: bare, authorization: `Basic ${credentials}` };
}

/** Ollama needs a plain HTTP(S) address; `localhost:11434` has no scheme fetch can use. */
export function hasHttpScheme(url: string): boolean {
  return HTTP_SCHEME.test(url);
}

/**
 * The part of the URL's credentials a redactor must know: the password as written and decoded,
 * or, when there is no password, the user (a lone `token@host` is the token).
 */
export function urlCredentialSecrets(url: string): string[] {
  const parts = splitUserinfo(url.trim());
  if (parts === undefined) return [];
  const secret = parts.password === '' ? parts.user : parts.password;
  return secret === '' ? [] : [...new Set([secret, decode(secret)])];
}
