import { describe, expect, it, vi } from 'vitest';
import {
  ERROR_PREVIEW_BYTES,
  getText,
  sameSiteAs,
  type Answer,
  type GetOptions,
} from '../../../src/adapters/sources/http.js';

// The debug tap of `getText` (W8-06): `onAnswer` sees the final answer of a request, and is off
// unless a caller passes it.

const URL_A = 'https://example.com/feed.xml';

function serving(...replies: Response[]): typeof fetch {
  let next = 0;
  return (): Promise<Response> => {
    const reply = replies[Math.min(next++, replies.length - 1)];
    return reply ? Promise.resolve(reply) : Promise.reject(new Error('no reply scripted'));
  };
}

function options(fetchFn: typeof fetch, overrides: Partial<GetOptions> = {}): GetOptions {
  return {
    fetch: fetchFn,
    label: 'example-feed',
    allowsRedirectTo: sameSiteAs(URL_A),
    ...overrides,
  };
}

function recorded(): { answers: Answer[]; onAnswer: (answer: Answer) => void } {
  const answers: Answer[] = [];
  return { answers, onAnswer: (answer) => answers.push(answer) };
}

describe('getText: onAnswer', () => {
  it('returns the reply as usual when no tap is given', async () => {
    const reply = await getText(
      URL_A,
      options(serving(new Response('<rss/>', { headers: { 'content-type': 'text/xml' } }))),
    );

    expect(reply.body).toBe('<rss/>');
  });

  it('reports the body, status and content type of a 2xx answer', async () => {
    const tap = recorded();
    const response = new Response('<rss/>', {
      status: 200,
      headers: { 'content-type': 'application/rss+xml; charset=utf-8' },
    });

    await getText(URL_A, options(serving(response), { onAnswer: tap.onAnswer }));

    expect(tap.answers).toEqual([
      {
        url: URL_A,
        status: 200,
        contentType: 'application/rss+xml; charset=utf-8',
        body: '<rss/>',
      },
    ]);
  });

  it('reports an undefined content type when the server sent none', async () => {
    const tap = recorded();
    const bare = new Response(new Uint8Array([0x3c, 0x72]), { status: 200 });

    await getText(URL_A, options(serving(bare), { onAnswer: tap.onAnswer }));

    expect(tap.answers[0]?.contentType).toBeUndefined();
  });

  it('reports the body of a non-2xx answer as a preview, and leaves the reply empty', async () => {
    const tap = recorded();
    const limited = new Response('{"message":"API rate limit exceeded"}', {
      status: 403,
      headers: { 'content-type': 'application/json' },
    });

    const reply = await getText(URL_A, options(serving(limited), { onAnswer: tap.onAnswer }));

    expect(reply).toEqual(expect.objectContaining({ ok: false, status: 403, body: '' }));
    expect(tap.answers).toEqual([
      {
        url: URL_A,
        status: 403,
        contentType: 'application/json',
        body: '{"message":"API rate limit exceeded"}',
      },
    ]);
  });

  it('cuts the preview of a long error page, and does not touch the reply', async () => {
    const tap = recorded();
    const page = new Response('x'.repeat(200 * 1024), { status: 502 });

    const reply = await getText(URL_A, options(serving(page), { onAnswer: tap.onAnswer }));

    expect(reply.body).toBe('');
    expect(tap.answers[0]?.body).toBe('x'.repeat(ERROR_PREVIEW_BYTES));
  });

  it('keeps the status of a failed answer when its body cannot be read for the preview', async () => {
    const tap = recorded();
    const broken = new Response(
      new ReadableStream<Uint8Array>({
        start(controller) {
          controller.error(new Error('connection reset'));
        },
      }),
      { status: 500 },
    );

    const reply = await getText(URL_A, options(serving(broken), { onAnswer: tap.onAnswer }));

    expect(reply).toEqual(expect.objectContaining({ ok: false, status: 500 }));
    expect(tap.answers).toEqual([expect.objectContaining({ status: 500, body: '' })]);
  });

  it('reports only the final answer of a redirect chain, under the url that answered', async () => {
    const tap = recorded();
    const hop = new Response(null, {
      status: 301,
      headers: { location: 'https://www.example.com/new-feed.xml' },
    });
    const final = new Response('<feed/>', { headers: { 'content-type': 'application/atom+xml' } });

    await getText(URL_A, options(serving(hop, final), { onAnswer: tap.onAnswer }));

    expect(tap.answers).toEqual([
      {
        url: 'https://www.example.com/new-feed.xml',
        status: 200,
        contentType: 'application/atom+xml',
        body: '<feed/>',
      },
    ]);
  });

  it('does not report a body that is over the size cap, which fails the request', async () => {
    const onAnswer = vi.fn();
    const big = new Response('x'.repeat(100));

    await expect(getText(URL_A, options(serving(big), { onAnswer, maxBytes: 10 }))).rejects.toThrow(
      /larger than/,
    );

    expect(onAnswer).not.toHaveBeenCalled();
  });

  it('reports no request headers, so a token cannot reach the tap', async () => {
    const tap = recorded();
    const headers = { Authorization: 'Bearer ghp_secret' };

    await getText(URL_A, options(serving(new Response('{}')), { headers, onAnswer: tap.onAnswer }));

    expect(JSON.stringify(tap.answers)).not.toContain('ghp_secret');
    expect(Object.keys(tap.answers[0] ?? {}).sort()).toEqual([
      'body',
      'contentType',
      'status',
      'url',
    ]);
  });
});
