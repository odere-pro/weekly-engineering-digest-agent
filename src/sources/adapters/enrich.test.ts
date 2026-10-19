import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { articleText, enrichEntries } from './enrich';
import type { RawEntry } from './entries/types';
import type { Get } from './pipeline';
import type { Reply } from './http';
import type { Source } from '../../domain/schemas';
import { FetchError } from '../../shared/errors';
import { noopLogger } from '../../shared/telemetry';

const page = (name: string): string =>
  readFileSync(new URL(`./__fixtures__/sources/pages/${name}`, import.meta.url), 'utf8');

const source: Source = { id: 'blog', kind: 'rss', url: 'https://example.com/feed.xml' };
const entry = (path: string, text = ''): RawEntry => ({
  url: `https://example.com/${path}`,
  title: path,
  text,
  publishedAt: '2026-10-10T00:00:00Z',
});
const reply = (body: string, contentType = 'text/html; charset=utf-8'): Reply => ({
  ok: true,
  status: 200,
  headers: new Headers({ 'content-type': contentType }),
  body,
});
const serving =
  (pages: Record<string, string>): Get =>
  async (url) =>
    reply(pages[url] ?? '');

const deps = (get: Get, extra: Record<string, unknown> = {}) => ({
  get,
  logger: noopLogger,
  ...extra,
});

describe('articleText', () => {
  it('takes the first paragraphs of the article, without script, style, nav, header or footer', () => {
    const text = articleText(page('article.html'));

    expect(text).toContain('The first real paragraph explains what shipped');
    expect(text).toContain('details & the numbers');
    expect(text).not.toMatch(
      /script text|color|Home About|Site header|Byline|Article footer|Site footer/,
    );
  });

  it('falls back to the text of <main> when it has no paragraphs', () => {
    expect(articleText(page('main.html'))).toBe(
      'Title Body text outside paragraphs is still taken when the page has no paragraph elements at all.',
    );
  });

  it('prefers og:description over the meta description', () => {
    expect(articleText(page('og.html'))).toBe('Open graph "summary" of the post.');
  });

  it('reads a meta description whatever the attribute order and quotes', () => {
    expect(articleText(page('meta-only.html'))).toBe('Single quoted description.');
  });

  it('returns nothing for a page without article text or description', () => {
    expect(articleText(page('empty.html'))).toBe('');
    expect(articleText('')).toBe('');
  });

  it('drops the rest of the page after an element that never closes, in linear time', () => {
    const hostile = `<article>${'<p>'.repeat(50_000)}`;
    const started = Date.now();
    articleText(hostile);
    expect(Date.now() - started).toBeLessThan(2000);
  });

  it('keeps an article nested in another article together', () => {
    const html =
      '<article><p>Outer start of the post body.</p><article><p>Inner article body text here.</p></article><p>Outer end of the post body.</p></article>';
    expect(articleText(html)).toBe(
      'Outer start of the post body. Inner article body text here. Outer end of the post body.',
    );
  });
});

describe('enrichEntries', () => {
  it('fills only entries whose text is empty', async () => {
    const get = vi.fn(serving({ 'https://example.com/a': page('article.html') }));

    const result = await enrichEntries([entry('a'), entry('b', 'has text')], source, deps(get));

    expect(result[0]?.text).toContain('first real paragraph');
    expect(result[1]?.text).toBe('has text');
    expect(get).toHaveBeenCalledTimes(1);
  });

  it('does not change the entries it is given', async () => {
    const input = [entry('a')];
    await enrichEntries(input, source, deps(serving({ 'https://example.com/a': page('og.html') })));
    expect(input[0]?.text).toBe('');
  });

  it('requests a page with the 2 MiB body cap', async () => {
    const get = vi.fn<Get>(async () => reply(''));
    await enrichEntries([entry('a')], source, deps(get));
    expect(get.mock.calls[0]?.[1]).toMatchObject({ maxBytes: 2 * 1024 * 1024 });
  });

  it('skips a page on another host without fetching it', async () => {
    const get = vi.fn<Get>(async () => reply(page('og.html')));
    const other: RawEntry = { ...entry('x'), url: 'https://elsewhere.example.org/x' };

    const result = await enrichEntries([other], source, deps(get));

    expect(get).not.toHaveBeenCalled();
    expect(result[0]?.text).toBe('');
  });

  it('treats www and the apex as one site', async () => {
    const get = vi.fn<Get>(async () => reply(page('og.html')));
    const www: RawEntry = { ...entry('x'), url: 'https://www.example.com/x' };
    const result = await enrichEntries([www], source, deps(get));
    expect(result[0]?.text).toContain('Open graph');
  });

  it('leaves the entry empty and logs at debug when a page fails, times out or is not a 2xx', async () => {
    const debug = vi.fn();
    const get: Get = async (url) => {
      if (url.endsWith('/boom')) throw new FetchError('HTTP 500', { status: 500, retryable: true });
      if (url.endsWith('/slow'))
        throw Object.assign(new Error('timed out'), { name: 'TimeoutError' });
      return { ...reply(''), ok: false, status: 404 };
    };

    const result = await enrichEntries(
      [entry('boom'), entry('slow'), entry('gone')],
      source,
      deps(get, { logger: { ...noopLogger, debug } }),
    );

    expect(result.map((e) => e.text)).toEqual(['', '', '']);
    expect(debug).toHaveBeenCalledTimes(3);
  });

  it('skips a response that is not a web page', async () => {
    const get: Get = async () => reply('%PDF binary', 'application/pdf');
    const result = await enrichEntries([entry('a')], source, deps(get));
    expect(result[0]?.text).toBe('');
  });

  it('runs at most four requests at a time', async () => {
    let inFlight = 0;
    let peak = 0;
    const get: Get = async () => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 5));
      inFlight -= 1;
      return reply(page('og.html'));
    };

    const entries = Array.from({ length: 12 }, (_, i) => entry(`p${i}`));
    const result = await enrichEntries(entries, source, deps(get));

    expect(peak).toBe(4);
    expect(result.every((e) => e.text !== '')).toBe(true);
  });

  it('stops starting pages once the budget is spent and leaves those entries empty', async () => {
    let now = 0;
    const get: Get = async () => {
      now += 400;
      return reply(page('og.html'));
    };

    const entries = Array.from({ length: 6 }, (_, i) => entry(`p${i}`));
    const result = await enrichEntries(
      entries,
      source,
      deps(get, { budgetMs: 1000, now: () => now, concurrency: 1 }),
    );

    expect(result.filter((e) => e.text !== '')).toHaveLength(3);
  });

  it('rethrows an abort so the collect step sees its timeout', async () => {
    const controller = new AbortController();
    const get: Get = async () => {
      controller.abort(new Error('stop'));
      throw new DOMException('aborted', 'AbortError');
    };
    await expect(
      enrichEntries([entry('a')], source, deps(get, { signal: controller.signal })),
    ).rejects.toThrow();
  });
});

describe('articleText fallbacks', () => {
  it('uses the description when the article holds only a short label', () => {
    const html =
      '<head><meta name="description" content="The real description of the post."></head><main><div>Learn more</div></main>';
    expect(articleText(html)).toBe('The real description of the post.');
  });
});

describe('enrichEntries origin and hostile pages', () => {
  it('does not fetch a page on another port or over plain http', async () => {
    const get = vi.fn<Get>(async () => reply(page('og.html')));
    const entries: RawEntry[] = [
      { ...entry('x'), url: 'https://example.com:8443/x' },
      { ...entry('y'), url: 'http://example.com/y' },
    ];
    await enrichEntries(entries, source, deps(get));
    expect(get).not.toHaveBeenCalled();
  });

  it('reads a page with an enormous meta tag in bounded time', () => {
    const html = `<meta ${'a'.repeat(200_000)}>`;
    const started = Date.now();
    articleText(html);
    expect(Date.now() - started).toBeLessThan(1000);
  });

  it('bounds a page by what is left of the budget', async () => {
    let seen: AbortSignal | undefined;
    const get: Get = async (_url, init) => {
      seen = init?.signal;
      return reply('');
    };
    await enrichEntries([entry('a')], source, deps(get, { budgetMs: 50 }));
    expect(seen?.aborted).toBe(false);
    await new Promise((resolve) => setTimeout(resolve, 80));
    expect(seen?.aborted).toBe(true);
  });
});
