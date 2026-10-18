import { describe, expect, it } from 'vitest';
import {
  getText,
  isRetryableStatus,
  MAX_BODY_BYTES,
  permanentFailure,
  sameSiteAs,
  statusFailure,
  type GetOptions,
} from './http';
import { FetchError } from '../../shared/errors';

const URL_A = 'https://example.com/feed.xml';

interface Call {
  url: string;
  init: RequestInit | undefined;
}

/** A fetch fake that records calls and answers each with the next response from `replies`. */
function sequence(...replies: (Response | Error)[]): { fetch: typeof fetch; calls: Call[] } {
  const calls: Call[] = [];
  const fake = (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    calls.push({ url, init });
    const reply = replies[Math.min(calls.length, replies.length) - 1];
    if (reply === undefined) return Promise.reject(new Error('no reply scripted'));
    return reply instanceof Error ? Promise.reject(reply) : Promise.resolve(reply);
  };
  return { fetch: fake, calls };
}

const redirect = (location: string | null, status = 301): Response =>
  new Response(null, { status, headers: location === null ? {} : { location } });

function options(fetchFn: typeof fetch, overrides: Partial<GetOptions> = {}): GetOptions {
  return {
    fetch: fetchFn,
    label: 'example-feed',
    allowsRedirectTo: sameSiteAs(URL_A),
    ...overrides,
  };
}

/** A body that yields `chunks` and records whether the reader walked away from it. */
function chunked(
  chunks: Uint8Array[],
  init: ResponseInit = {},
): { response: Response; cancelled: () => boolean } {
  let cancelled = false;
  let index = 0;
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      const chunk = chunks[index++];
      if (chunk === undefined) controller.close();
      else controller.enqueue(chunk);
    },
    cancel() {
      cancelled = true;
    },
  });
  return { response: new Response(stream, init), cancelled: () => cancelled };
}

async function failureOf(promise: Promise<unknown>): Promise<FetchError> {
  const error = await promise.then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(error).toBeInstanceOf(FetchError);
  return error as FetchError;
}

describe('getText', () => {
  describe('a plain answer', () => {
    it('returns the status, headers and decoded body of a 200', async () => {
      const { fetch } = sequence(
        new Response('hello feed', { status: 200, headers: { 'x-test': 'yes' } }),
      );

      const reply = await getText(URL_A, options(fetch));

      expect(reply).toMatchObject({ ok: true, status: 200, body: 'hello feed' });
      expect(reply.headers.get('x-test')).toBe('yes');
    });

    it('requests the url as given, with redirects handled by us, plus headers and signal', async () => {
      const { fetch, calls } = sequence(new Response('x'));
      const signal = new AbortController().signal;

      await getText(URL_A, options(fetch, { headers: { Accept: 'application/xml' }, signal }));

      expect(calls).toHaveLength(1);
      expect(calls[0]?.url).toBe(URL_A);
      expect(calls[0]?.init).toMatchObject({
        redirect: 'manual',
        headers: { Accept: 'application/xml' },
        signal,
      });
    });

    it('decodes UTF-8 characters split across chunks and drops a BOM', async () => {
      const bytes = new TextEncoder().encode('﻿café \u{1F600}');
      const { response } = chunked([bytes.slice(0, 5), bytes.slice(5, 9), bytes.slice(9)]);
      const { fetch } = sequence(response);

      const reply = await getText(URL_A, options(fetch));

      expect(reply.body).toBe('café \u{1F600}');
    });

    it('reads an empty body as an empty string', async () => {
      const { fetch } = sequence(new Response(null, { status: 200 }));

      expect((await getText(URL_A, options(fetch))).body).toBe('');
    });

    it('returns a non-2xx answer without reading its body', async () => {
      const { response, cancelled } = chunked([new TextEncoder().encode('upstream detail')], {
        status: 503,
        headers: { 'retry-after': '5' },
      });
      const { fetch } = sequence(response);

      const reply = await getText(URL_A, options(fetch));

      expect(reply).toMatchObject({ ok: false, status: 503, body: '' });
      expect(reply.headers.get('retry-after')).toBe('5');
      expect(cancelled()).toBe(true);
    });

    it('lets a network failure from fetch through unchanged', async () => {
      const failure = new TypeError('fetch failed');
      const { fetch } = sequence(failure);

      await expect(getText(URL_A, options(fetch))).rejects.toBe(failure);
    });
  });

  describe('redirects', () => {
    it.each([301, 302, 303, 307, 308])('follows a %i to the same host', async (status) => {
      const { fetch, calls } = sequence(
        redirect('https://example.com/moved.xml', status),
        new Response('moved body'),
      );

      const reply = await getText(URL_A, options(fetch));

      expect(reply.body).toBe('moved body');
      expect(calls.map((call) => call.url)).toEqual([URL_A, 'https://example.com/moved.xml']);
    });

    it('resolves a relative location against the current url', async () => {
      const { fetch, calls } = sequence(redirect('/new/feed.xml'), new Response('ok'));

      await getText(URL_A, options(fetch));

      expect(calls[1]?.url).toBe('https://example.com/new/feed.xml');
    });

    it('follows a chain of redirects', async () => {
      const { fetch, calls } = sequence(
        redirect('https://example.com/a'),
        redirect('https://example.com/b'),
        new Response('end'),
      );

      expect((await getText(URL_A, options(fetch))).body).toBe('end');
      expect(calls).toHaveLength(3);
    });

    it('treats the apex and the www host as the same host, in both directions', async () => {
      const toWww = sequence(redirect('https://www.example.com/feed.xml'), new Response('ok'));
      const fromWww = sequence(redirect('https://example.com/feed.xml'), new Response('ok'));
      const www = 'https://www.example.com/feed.xml';

      await getText(URL_A, options(toWww.fetch));
      await getText(www, options(fromWww.fetch, { allowsRedirectTo: sameSiteAs(www) }));

      expect(toWww.calls).toHaveLength(2);
      expect(fromWww.calls).toHaveLength(2);
    });

    it('allows an extra host named by the caller', async () => {
      const { fetch, calls } = sequence(
        redirect('https://api.example.net/feed'),
        new Response('api body'),
      );

      const reply = await getText(
        URL_A,
        options(fetch, { allowsRedirectTo: sameSiteAs(URL_A, 'api.example.net') }),
      );

      expect(reply.body).toBe('api body');
      expect(calls).toHaveLength(2);
    });

    it('fails the source on a redirect to another host, without requesting it', async () => {
      const { fetch, calls } = sequence(redirect('https://evil.example.org/feed.xml'));

      const error = await failureOf(getText(URL_A, options(fetch)));

      expect(error.retryable).toBe(false);
      expect(error.message).toContain('example-feed');
      expect(error.message).toContain('evil.example.org');
      expect(calls).toHaveLength(1);
    });

    it('does not echo the redirect path or query, which can carry secrets', async () => {
      const { fetch } = sequence(redirect('https://evil.example.org/p?token=SECRET#frag'));

      const error = await failureOf(getText(URL_A, options(fetch)));

      expect(error.message).not.toContain('SECRET');
      expect(error.message).not.toContain('/p');
    });

    it('refuses a host that only looks like the source host', async () => {
      const { fetch } = sequence(redirect('https://example.com.evil.org/feed.xml'));

      await failureOf(getText(URL_A, options(fetch)));
    });

    it('refuses a redirect from https to http', async () => {
      const { fetch, calls } = sequence(redirect('http://example.com/feed.xml'));

      const error = await failureOf(getText(URL_A, options(fetch)));

      expect(error.message).toMatch(/https to http/);
      expect(calls).toHaveLength(1);
    });

    it('allows a redirect from http to https', async () => {
      const { fetch } = sequence(redirect('https://example.com/feed.xml'), new Response('ok'));

      const reply = await getText('http://example.com/feed.xml', options(fetch));

      expect(reply.body).toBe('ok');
    });

    // Same host, other scheme: only the scheme check stops these.
    it.each(['ftp://example.com/feed.xml', 'ws://example.com/feed', 'wss://example.com/feed'])(
      'refuses a redirect to %s',
      async (location) => {
        const { fetch, calls } = sequence(redirect(location));

        const error = await failureOf(getText(URL_A, options(fetch)));

        expect(error.message).toMatch(/non-http/);
        expect(calls).toHaveLength(1);
      },
    );

    it('refuses a protocol-relative redirect to another host', async () => {
      const { fetch, calls } = sequence(redirect('//evil.example.org/feed.xml'));

      const error = await failureOf(getText(URL_A, options(fetch)));

      expect(error.message).toContain('evil.example.org');
      expect(calls).toHaveLength(1);
    });

    it('refuses a redirect to a URL that carries credentials, without echoing them', async () => {
      const { fetch, calls } = sequence(redirect('https://user:hunter2@example.com/feed.xml'));

      const error = await failureOf(getText(URL_A, options(fetch)));

      expect(error.message).not.toContain('hunter2');
      expect(error.message).not.toContain('user');
      expect(calls).toHaveLength(1);
    });

    it('refuses a redirect to another port of the same host', async () => {
      const { fetch, calls } = sequence(redirect('https://example.com:8443/feed.xml'));

      const error = await failureOf(getText(URL_A, options(fetch)));

      expect(error.message).toContain('port');
      expect(calls).toHaveLength(1);
    });

    it('follows a redirect that keeps a non-default port', async () => {
      const start = 'https://example.com:8443/feed.xml';
      const { fetch, calls } = sequence(
        redirect('https://example.com:8443/moved.xml'),
        new Response('ok'),
      );

      await getText(start, options(fetch, { allowsRedirectTo: sameSiteAs(start) }));

      expect(calls).toHaveLength(2);
    });

    it('fails on a redirect without a location', async () => {
      const { fetch } = sequence(redirect(null));

      const error = await failureOf(getText(URL_A, options(fetch)));

      expect(error.retryable).toBe(false);
      expect(error.message).toContain('example-feed');
    });

    it('fails on a location that is not a url', async () => {
      const { fetch } = sequence(redirect('http://'));

      const error = await failureOf(getText(URL_A, options(fetch)));

      expect(error.retryable).toBe(false);
    });

    it('gives up after five redirects', async () => {
      const { fetch, calls } = sequence(redirect('https://example.com/loop'));

      const error = await failureOf(getText(URL_A, options(fetch)));

      expect(error.message).toMatch(/too many redirects/i);
      expect(error.retryable).toBe(false);
      expect(calls).toHaveLength(6);
    });

    it('does not read the body of a redirect answer', async () => {
      const { response, cancelled } = chunked([new TextEncoder().encode('moved')], {
        status: 301,
        headers: { location: 'https://example.com/moved' },
      });
      const { fetch } = sequence(response, new Response('ok'));

      await getText(URL_A, options(fetch));

      expect(cancelled()).toBe(true);
    });

    it('keeps credentials on the same origin and drops them on another one', async () => {
      const { fetch, calls } = sequence(
        redirect('https://example.com/same-origin'),
        redirect('https://www.example.com/other-origin'),
        new Response('ok'),
      );
      const headers = { Authorization: 'Bearer SECRET', Accept: 'application/json' };

      await getText(URL_A, options(fetch, { headers }));

      expect(calls[1]?.init?.headers).toEqual(headers);
      expect(calls[2]?.init?.headers).toEqual({ Accept: 'application/json' });
    });

    it('sends another origin only the headers that are safe to share', async () => {
      const { fetch, calls } = sequence(redirect('https://www.example.com/x'), new Response('ok'));
      const headers = {
        authorization: 'Bearer SECRET',
        Cookie: 'session=SECRET',
        'X-Api-Key': 'SECRET',
        ACCEPT: 'application/json',
        'X-GitHub-Api-Version': '2022-11-28',
      };

      await getText(URL_A, options(fetch, { headers }));

      expect(calls[1]?.init?.headers).toEqual({
        ACCEPT: 'application/json',
        'X-GitHub-Api-Version': '2022-11-28',
      });
    });
  });

  describe('the starting url', () => {
    it.each(['not a url', 'ftp://example.com/feed.xml', 'file:///etc/passwd'])(
      'refuses %s without calling fetch',
      async (url) => {
        const { fetch, calls } = sequence(new Response('x'));

        const error = await failureOf(getText(url, options(fetch)));

        expect(error.retryable).toBe(false);
        expect(error.message).toContain('example-feed');
        expect(calls).toHaveLength(0);
      },
    );

    it.each([
      'https://alice:hunter2@example.com/feed.xml?token=abc123',
      'https://alice@example.com/feed.xml',
      'https://:hunter2@example.com/feed.xml',
      'http://alice:hunter2@example.com/',
    ])('refuses %s without calling fetch and without echoing it', async (url) => {
      const { fetch, calls } = sequence(new Response('x'));

      const error = await failureOf(getText(url, options(fetch)));

      expect(error.retryable).toBe(false);
      expect(error.message).toContain('example-feed');
      expect(error.message).toMatch(/username or password/);
      expect(error.message).not.toMatch(/alice|hunter2|abc123|example\.com|feed\.xml/);
      expect(calls).toHaveLength(0);
    });

    it.each([
      'https://example.com/feed?contact=alice@example.org',
      'https://example.com/@alice/feed.xml',
      'https://example.com/feed.xml#alice:hunter2@x',
    ])('does not mistake the "@" of %s for credentials', async (url) => {
      const { fetch, calls } = sequence(new Response('ok'));

      const reply = await getText(url, options(fetch));

      expect(reply.body).toBe('ok');
      expect(calls).toHaveLength(1);
    });
  });

  describe('body size cap', () => {
    it('caps a body at 5 MiB', () => {
      expect(MAX_BODY_BYTES).toBe(5 * 1024 * 1024);
    });

    it('refuses a body whose content-length is over the cap, before reading it', async () => {
      const { response, cancelled } = chunked([new TextEncoder().encode('tiny')], {
        headers: { 'content-length': String(MAX_BODY_BYTES + 1) },
      });
      const { fetch } = sequence(response);

      const error = await failureOf(getText(URL_A, options(fetch)));

      expect(error.retryable).toBe(false);
      expect(error.message).toMatch(/5 MiB/);
      expect(error.message).toContain('example-feed');
      expect(cancelled()).toBe(true);
    });

    it('stops reading a body that grows past the cap with no content-length', async () => {
      const chunk = new Uint8Array(1024 * 1024);
      const { response, cancelled } = chunked(Array.from({ length: 8 }, () => chunk));
      const { fetch } = sequence(response);

      const error = await failureOf(getText(URL_A, options(fetch)));

      expect(error.message).toMatch(/5 MiB/);
      expect(cancelled()).toBe(true);
    });

    it('accepts a body of exactly the cap', async () => {
      const body = new Uint8Array(MAX_BODY_BYTES).fill(0x61);
      const { fetch } = sequence(new Response(body));

      expect((await getText(URL_A, options(fetch))).body).toHaveLength(MAX_BODY_BYTES);
    });

    it('honors a smaller cap from the caller', async () => {
      const { fetch } = sequence(new Response('0123456789'));

      await failureOf(getText(URL_A, options(fetch, { maxBytes: 9 })));
    });

    it('ignores a content-length that is not a number', async () => {
      const { fetch } = sequence(new Response('ok', { headers: { 'content-length': 'many' } }));

      expect((await getText(URL_A, options(fetch))).body).toBe('ok');
    });

    it('keeps the name of an error raised while the body is read', async () => {
      const stream = new ReadableStream<Uint8Array>({
        pull(controller) {
          controller.error(new DOMException('This operation was aborted', 'AbortError'));
        },
      });
      const { fetch } = sequence(new Response(stream));

      await expect(getText(URL_A, options(fetch))).rejects.toMatchObject({ name: 'AbortError' });
    });
  });
});

describe('isRetryableStatus', () => {
  it.each([408, 429, 500, 502, 503, 504, 599])('retries HTTP %i', (status) => {
    expect(isRetryableStatus(status)).toBe(true);
  });

  it.each([400, 401, 403, 404, 405, 410, 418, 451])('does not retry HTTP %i', (status) => {
    expect(isRetryableStatus(status)).toBe(false);
  });
});

describe('statusFailure', () => {
  it('names the status and the source, and says whether to retry', () => {
    const retryable = statusFailure(503, 'example-feed');
    const permanent = statusFailure(404, 'example-feed');

    expect(retryable).toBeInstanceOf(FetchError);
    expect(retryable).toMatchObject({
      message: 'HTTP 503 fetching example-feed',
      status: 503,
      retryable: true,
    });
    expect(permanent).toMatchObject({ status: 404, retryable: false });
  });
});

describe('permanentFailure', () => {
  it('is a FetchError that no retry can fix and keeps its cause', () => {
    const cause = new Error('root');

    const error = permanentFailure('Cannot parse feed x', cause);

    expect(error).toBeInstanceOf(FetchError);
    expect(error).toMatchObject({ retryable: false, cause });
    expect(error.status).toBeUndefined();
  });
});

describe('sameSiteAs', () => {
  const allows = sameSiteAs('https://Example.com/feed.xml', 'api.example.net');

  it.each(['example.com', 'EXAMPLE.com', 'www.example.com', 'api.example.net', 'API.example.net'])(
    'allows %s',
    (hostname) => {
      expect(allows(hostname)).toBe(true);
    },
  );

  it.each([
    'evil.org',
    'example.com.evil.org',
    'sub.example.com',
    'www.api.example.net',
    'example.net',
    'ww.example.com',
  ])('refuses %s', (hostname) => {
    expect(allows(hostname)).toBe(false);
  });

  it('allows only the extra hosts when the source url is not a url', () => {
    const allowsExtras = sameSiteAs('not a url', 'api.example.net');

    expect(allowsExtras('api.example.net')).toBe(true);
    expect(allowsExtras('example.com')).toBe(false);
  });

  it('treats a www source host as the apex too', () => {
    expect(sameSiteAs('https://www.docker.com/feed/')('docker.com')).toBe(true);
  });
});
