import { describe, expect, it } from 'vitest';
import { createGithubRestAdapter } from '../../../src/adapters/sources/githubRestAdapter.js';
import type { Reply } from '../../../src/adapters/sources/http.js';
import type { Source } from '../../../src/core/schemas.js';

const TOKEN = 'ghp_testtoken1234567890';
const source: Source = { id: 'widgets', kind: 'github', url: 'https://github.com/acme/widgets' };
const adapter = createGithubRestAdapter(TOKEN);
const reply = (body: string, status = 200): Reply => ({
  ok: status >= 200 && status < 300,
  status,
  headers: new Headers(),
  body,
});
const release = (tag: string, extra: Record<string, unknown> = {}) => ({
  tag_name: tag,
  name: tag,
  html_url: `https://github.com/acme/widgets/releases/tag/${tag}`,
  draft: false,
  prerelease: false,
  published_at: '2026-10-10T08:00:00Z',
  body: `notes for ${tag}`,
  ...extra,
});

describe('githubRestAdapter', () => {
  it('requests the API with the bearer token, allows api.github.com and does not enrich', async () => {
    const seen: { url: string; headers?: Record<string, string> | undefined }[] = [];
    await adapter.request(source, {} as never, async (url, init) => {
      seen.push({ url, headers: init?.headers });
      return reply('[]');
    });

    expect(seen[0]?.url).toBe('https://api.github.com/repos/acme/widgets/releases?per_page=20');
    expect(seen[0]?.headers?.Authorization).toBe(`Bearer ${TOKEN}`);
    expect(adapter.redirectHosts).toEqual(['api.github.com']);
    expect(adapter.enrichable).toBe(false);
  });

  it('removes the token from a network error and drops its cause', async () => {
    const error = (await adapter
      .request(source, {} as never, async () => {
        throw Object.assign(new TypeError(`fetch failed for ${TOKEN}`), {
          cause: { token: TOKEN },
        });
      })
      .catch((e: unknown) => e)) as Error;

    expect(error.message).not.toContain(TOKEN);
    expect(error.message).toContain('[redacted]');
    expect(error.name).toBe('TypeError');
    expect(error.cause).toBeUndefined();
  });

  it('reports a rate limit without retry', async () => {
    const limited: Reply = {
      ...reply('', 403),
      headers: new Headers({ 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': '1790000000' }),
    };
    await expect(adapter.request(source, {} as never, async () => limited)).rejects.toThrow(
      /rate limit.*resets at/,
    );
  });

  it('parses releases and skips drafts, prereleases and entries without a date or github link', () => {
    const body = JSON.stringify([
      release('v1', { body: 'Uses `Vec<T>` here' }),
      release('draft', { draft: true }),
      release('pre', { prerelease: true }),
      release('nodate', { published_at: null }),
      release('elsewhere', { html_url: 'https://evil.example/x' }),
    ]);
    const entries = adapter.parse(reply(body), source);

    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      title: 'widgets v1',
      url: 'https://github.com/acme/widgets/releases/tag/v1',
    });
    expect(entries[0]?.text).toContain('Vec&lt;T&gt;');
  });

  it('names the release when it differs from the tag', () => {
    const [entry] = adapter.parse(reply(JSON.stringify([release('v2', { name: 'Two' })])), source);
    expect(entry?.title).toBe('widgets v2: Two');
  });

  it.each([
    ['not JSON', 'nope', /Malformed GitHub API response/],
    ['not a list', '{}', /expected a list/],
    ['a list nothing in which matches', '[1,2]', /no release matched/],
  ])('fails permanently on a body that is %s', (_label, body, message) => {
    expect(() => adapter.parse(reply(body), source)).toThrow(message);
  });
});
