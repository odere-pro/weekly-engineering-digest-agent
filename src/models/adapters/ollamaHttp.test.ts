import { describe, expect, it } from 'vitest';
import { DigestError } from '../../shared/errors';
import { json, refused } from './__fixtures__/ollamaHarness';
import { createOllamaHttp, isRetryable, OllamaNetworkError } from './ollamaHttp';

const PASSWORD = 'S3cretPw';
const ROOT = 'http://127.0.0.1:11434';
const WITH_CREDENTIALS = `http://user:${PASSWORD}@127.0.0.1:11434`;
const BASIC = `Basic ${Buffer.from(`user:${PASSWORD}`).toString('base64')}`;

interface Sent {
  url: string;
  init: RequestInit | undefined;
}

type Answer = (request: Sent) => Response | Promise<Response>;

/** Records what it is given. Like Node's fetch, it refuses a URL that has credentials. */
function recordingFetch(answer: Answer): { fetch: typeof fetch; requests: Sent[] } {
  const requests: Sent[] = [];
  const fetchFn = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const request = { url: input instanceof Request ? input.url : input.toString(), init };
    requests.push(request);
    if (/^[a-z]+:\/\/[^/]*@/i.test(request.url))
      throw new TypeError(
        `Request cannot be constructed from a URL that includes credentials: ${request.url}`,
      );
    return answer(request);
  };
  return { fetch: fetchFn, requests };
}

const signal = (): AbortSignal => new AbortController().signal;
const authorizationOf = (request: Sent | undefined): unknown =>
  (request?.init?.headers as Record<string, string> | undefined)?.['authorization'];
const failureOf = (promise: Promise<unknown>): Promise<Error> =>
  promise.then(
    () => {
      throw new Error('expected the request to fail');
    },
    (error: unknown) => error as Error,
  );

describe('createOllamaHttp credentials in the base URL', () => {
  it('sends them as a Basic authorization header, on GET and POST', async () => {
    const { fetch, requests } = recordingFetch(() => json(200, {}));
    const http = createOllamaHttp(WITH_CREDENTIALS, fetch);

    await http.get('/api/tags', signal());
    await http.post('/api/show', { model: 'm' }, signal());

    expect(requests.map((request) => request.url)).toEqual([
      `${ROOT}/api/tags`,
      `${ROOT}/api/show`,
    ]);
    expect(requests.map(authorizationOf)).toEqual([BASIC, BASIC]);
    expect(requests[1]?.init?.headers).toMatchObject({ 'content-type': 'application/json' });
  });

  it('sends the decoded credentials of a percent-encoded URL', async () => {
    const { fetch, requests } = recordingFetch(() => json(200, {}));
    const http = createOllamaHttp('http://me%40corp:p%40ss@127.0.0.1:11434', fetch);

    await http.get('/api/tags', signal());

    expect(authorizationOf(requests[0])).toBe(
      `Basic ${Buffer.from('me@corp:p@ss').toString('base64')}`,
    );
  });

  it('exposes a baseUrl without them', () => {
    const http = createOllamaHttp(
      `${WITH_CREDENTIALS}/`,
      recordingFetch(() => json(200, {})).fetch,
    );

    expect(http.baseUrl).toBe(ROOT);
  });

  it('sends no authorization header when the URL has none', async () => {
    const { fetch, requests } = recordingFetch(() => json(200, {}));
    const http = createOllamaHttp(ROOT, fetch);

    await http.get('/api/tags', signal());
    await http.post('/api/show', {}, signal());

    expect(requests.map(authorizationOf)).toEqual([undefined, undefined]);
  });

  it('keeps the password out of the message of a failed request', async () => {
    const { fetch } = recordingFetch(() => {
      throw new TypeError('fetch failed', { cause: new Error('socket hang up') });
    });
    const http = createOllamaHttp(WITH_CREDENTIALS, fetch);

    const error = await failureOf(http.get('/api/tags', signal()));

    expect(error).toBeInstanceOf(OllamaNetworkError);
    expect(error.message).toContain(`${ROOT}/api/tags`);
    expect(error.message).not.toContain(PASSWORD);
    expect(error.message).not.toContain('user:');
  });

  it('keeps the password out of a URL that does not parse', async () => {
    const { fetch, requests } = recordingFetch(() => {
      throw new TypeError('Failed to parse URL');
    });
    const http = createOllamaHttp(`http://user:${PASSWORD}@127.0.0.1:99999`, fetch);

    const error = await failureOf(http.get('/api/tags', signal()));

    expect(requests[0]?.url).toBe('http://127.0.0.1:99999/api/tags');
    expect(error.message).not.toContain(PASSWORD);
  });
});

describe('createOllamaHttp redirects', () => {
  const redirect = (status: number, location?: string): Response =>
    new Response(null, { status, headers: location ? { location } : {} });

  it('asks fetch not to follow them', async () => {
    const { fetch, requests } = recordingFetch(() => json(200, {}));
    const http = createOllamaHttp(ROOT, fetch);

    await http.get('/api/tags', signal());
    await http.post('/api/chat', {}, signal());
    await http.postStream('/api/chat', {}, signal()).catch(() => undefined);

    expect(requests.map((request) => request.init?.redirect)).toEqual([
      'manual',
      'manual',
      'manual',
    ]);
  });

  it.each([301, 302, 303, 307, 308])(
    'turns a %i answer into an error that names the URL and says to set OLLAMA_URL',
    async (status) => {
      const { fetch } = recordingFetch(() =>
        redirect(status, 'https://ollama.example.test/api/chat'),
      );
      const http = createOllamaHttp(WITH_CREDENTIALS, fetch);

      const error = await failureOf(http.post('/api/chat', { prompt: 'x' }, signal()));

      expect(error.message).toContain(`Ollama at ${ROOT} answered /api/chat with a redirect`);
      expect(error.message).toContain(`HTTP ${status.toString()}`);
      expect(error.message).toContain('https://ollama.example.test/api/chat');
      expect(error.message).toContain('set OLLAMA_URL');
      expect(error.message).not.toContain(PASSWORD);
    },
  );

  it('is not worth another attempt', async () => {
    const { fetch } = recordingFetch(() => redirect(308, 'https://elsewhere.test/'));
    const http = createOllamaHttp(ROOT, fetch);

    const error = await failureOf(http.get('/api/tags', signal()));

    expect(error).toBeInstanceOf(DigestError);
    expect(isRetryable(error)).toBe(false);
  });

  it('shows the target without its credentials, query or fragment', async () => {
    const { fetch } = recordingFetch(() =>
      redirect(307, 'https://u:p@other.test:8443/ollama/api/tags?token=abc#frag'),
    );
    const http = createOllamaHttp(ROOT, fetch);

    const error = await failureOf(http.get('/api/tags', signal()));

    expect(error.message).toContain('https://other.test:8443/ollama/api/tags');
    expect(error.message).not.toMatch(/u:p|token|abc|frag/);
  });

  it('resolves a relative target against the request URL', async () => {
    const { fetch } = recordingFetch(() => redirect(301, '/ollama/api/tags'));
    const http = createOllamaHttp(ROOT, fetch);

    const error = await failureOf(http.get('/api/tags', signal()));

    expect(error.message).toContain(`${ROOT}/ollama/api/tags`);
  });

  it('still reports a redirect that names no usable target', async () => {
    const answers = [redirect(302), redirect(302, 'javascript:alert(1)'), redirect(302, 'http://')];
    const { fetch } = recordingFetch(() => answers.shift() ?? json(200, {}));
    const http = createOllamaHttp(ROOT, fetch);

    for (let attempt = 0; attempt < 3; attempt++) {
      const error = await failureOf(http.get('/api/tags', signal()));
      expect(error.message).toContain(
        `Ollama at ${ROOT} answered /api/tags with a redirect (HTTP 302)`,
      );
    }
  });

  it('does not take other statuses for redirects', async () => {
    const { fetch } = recordingFetch(() => json(404, { error: 'model not found' }));
    const http = createOllamaHttp(ROOT, fetch);

    const error = await failureOf(http.get('/api/tags', signal()));

    expect(error.message).toBe('Ollama returned 404 for /api/tags: model not found');
  });
});

describe('createOllamaHttp errors that name the configured URL', () => {
  it('names the full request URL when the connection fails', async () => {
    const { fetch } = recordingFetch(refused);
    const http = createOllamaHttp(`${ROOT}/`, fetch);

    const error = await failureOf(http.get('/api/tags', signal()));

    expect(error.message).toBe(
      `Ollama request to ${ROOT}/api/tags failed: fetch failed: connect ECONNREFUSED 127.0.0.1:11434`,
    );
  });

  it.each(['localhost:11434', '127.0.0.1:11434', 'ftp://localhost:11434', ''])(
    'says OLLAMA_URL must start with http:// or https:// for %j, without asking fetch',
    async (url) => {
      const { fetch, requests } = recordingFetch(() => json(200, {}));
      const http = createOllamaHttp(url, fetch);

      const error = await failureOf(http.get('/api/tags', signal()));

      expect(error).toBeInstanceOf(DigestError);
      expect(error.message).toContain('OLLAMA_URL must start with http:// or https://');
      expect(error.message).toContain(`"${url}"`);
      expect(requests).toEqual([]);
      expect(isRetryable(error)).toBe(false);
    },
  );

  it('does not print the credentials of a URL that has no scheme', async () => {
    const http = createOllamaHttp(
      `user:${PASSWORD}@localhost:11434`,
      recordingFetch(refused).fetch,
    );

    const error = await failureOf(http.post('/api/chat', {}, signal()));

    expect(error.message).toContain('"localhost:11434"');
    expect(error.message).not.toContain(PASSWORD);
  });
});
