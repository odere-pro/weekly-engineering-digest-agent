import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  BASE_URL,
  fakeContext,
  fixture,
  hang,
  json,
  refused,
  UNREACHABLE,
  type Call,
} from '../__fixtures__/ollamaHarness';
import { health } from './health';

function healthy(call: Call): Response {
  if (call.url.endsWith('/api/version')) return json(200, fixture('version.json'));
  return json(200, fixture('tags.json'));
}

describe('health', () => {
  it('maps the version and each model’s capabilities and digest', async () => {
    const { http, calls } = fakeContext(healthy);

    const result = await health(http);

    expect(result).toEqual({
      reachable: true,
      version: '0.40.4',
      models: [
        {
          name: 'clef:latest',
          capabilities: ['decision', 'vision'],
          digest: '039c167bd0ec3719dd055f448dd55ea2365330bc05f2737e042ea0d23659756b',
        },
        {
          name: 'gemma4:e4b-mlx',
          capabilities: ['completion', 'vision', 'audio', 'tools', 'thinking'],
          digest: '5a08735df03c348ab10d56e8ad758098ff1960ab6030605c95fde7d90fc9de18',
        },
        {
          name: 'strands-decider:2b-mlx-bf16',
          capabilities: ['decision'],
          digest: 'd7afa63135f68f27fb25ca97dad22b6434ad927aaa491985e2845813b4fbffb4',
        },
      ],
    });
    expect(calls.map((c) => [c.method, c.url]).sort()).toEqual([
      ['GET', `${BASE_URL}/api/tags`],
      ['GET', `${BASE_URL}/api/version`],
    ]);
  });

  it('keeps every model when one lists an empty digest, and leaves that digest out', async () => {
    const { http } = fakeContext((call) =>
      call.url.endsWith('/api/version')
        ? json(200, { version: '0.40.5' })
        : json(200, {
            models: [
              { name: 'clef:latest', digest: '' },
              { name: 'granite4.1-guardian:8b', digest: 'f82c0882' },
            ],
          }),
    );

    const result = await health(http);

    expect(result.error).toBeUndefined();
    expect(result.models).toEqual([
      { name: 'clef:latest', capabilities: [] },
      { name: 'granite4.1-guardian:8b', capabilities: [], digest: 'f82c0882' },
    ]);
  });

  it('gives a model without capabilities an empty list, and no digest when none is listed', async () => {
    const { http } = fakeContext((call) =>
      call.url.endsWith('/api/version')
        ? json(200, { version: '0.30.0' })
        : json(200, { models: [{ name: 'old:latest' }] }),
    );
    const result = await health(http);
    expect(result.models).toEqual([{ name: 'old:latest', capabilities: [] }]);
  });

  it('reports unreachable Ollama without throwing', async () => {
    const { http } = fakeContext(refused);
    await expect(health(http)).resolves.toEqual({
      reachable: false,
      models: [],
      error: UNREACHABLE,
    });
  });

  it('reports a failed model list while Ollama itself answers', async () => {
    const { http } = fakeContext((call) =>
      call.url.endsWith('/api/version')
        ? json(200, { version: '0.40.4' })
        : json(500, { error: 'disk read failed' }),
    );
    await expect(health(http)).resolves.toEqual({
      reachable: true,
      version: '0.40.4',
      models: [],
      error: 'Ollama returned 500 for /api/tags: disk read failed',
    });
  });

  it('reports an unexpected version payload', async () => {
    const { http } = fakeContext((call) =>
      call.url.endsWith('/api/version') ? json(200, { v: 1 }) : json(200, { models: [] }),
    );
    const result = await health(http);
    expect(result.reachable).toBe(false);
    expect(result.error).toMatch(/unexpected \/api\/version response/);
  });

  it('reports an unexpected model list while Ollama itself answers', async () => {
    const { http } = fakeContext((call) =>
      call.url.endsWith('/api/version') ? json(200, { version: '0.40.4' }) : json(200, {}),
    );
    const result = await health(http);
    expect(result).toMatchObject({ reachable: true, version: '0.40.4', models: [] });
    expect(result.error).toMatch(/unexpected \/api\/tags response/);
  });

  it('does not retry a failed request', async () => {
    const { http, calls } = fakeContext(() => json(500, { error: 'boom' }));
    await health(http);
    expect(calls).toHaveLength(2);
  });

  describe('when the Ollama URL carries a password', () => {
    const PASSWORD = 'S3cretPw';
    const WITH_PASSWORD = `http://user:${PASSWORD}@127.0.0.1:11434`;

    it('names the address without it when Ollama is not reachable', async () => {
      const { http } = fakeContext(refused, { baseUrl: WITH_PASSWORD });

      const result = await health(http);

      expect(result).toEqual({ reachable: false, models: [], error: UNREACHABLE });
    });

    it('leaves it out of an error that quotes the URL it was sent to', async () => {
      const { http, calls } = fakeContext(
        (call) => {
          throw new TypeError(`fetch failed for ${call.url}`);
        },
        { baseUrl: WITH_PASSWORD },
      );

      const result = await health(http);

      expect(calls.map((call) => call.url).sort()).toEqual([
        `${BASE_URL}/api/tags`,
        `${BASE_URL}/api/version`,
      ]);
      expect(result.error).toContain(`${BASE_URL}/api/version`);
      expect(result.error).not.toContain(PASSWORD);
    });

    it('names a redirect, and the address without the password', async () => {
      const { http } = fakeContext(
        () => new Response(null, { status: 308, headers: { location: 'https://other.test/' } }),
        { baseUrl: WITH_PASSWORD },
      );

      const result = await health(http);

      expect(result.reachable).toBe(false);
      expect(result.error).toContain(`Ollama at ${BASE_URL} answered /api/version with a redirect`);
      expect(result.error).not.toContain(PASSWORD);
    });
  });

  it('tells the user that OLLAMA_URL needs a scheme when it has none', async () => {
    const { http, calls } = fakeContext(() => json(200, {}), { baseUrl: 'localhost:11434' });

    const result = await health(http);

    expect(result.reachable).toBe(false);
    expect(result.error).toContain('OLLAMA_URL must start with http:// or https://');
    expect(calls).toEqual([]);
  });

  describe('with fake timers', () => {
    beforeEach(() => {
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    });
    afterEach(() => {
      vi.useRealTimers();
    });

    it('reports a hung Ollama after the health timeout', async () => {
      const { http } = fakeContext((call) => hang(call.signal));
      const pending = health(http);
      await vi.advanceTimersByTimeAsync(5_000);
      await expect(pending).resolves.toEqual({
        reachable: false,
        models: [],
        error: `Ollama at ${BASE_URL} did not answer within 5000 ms`,
      });
    });

    it('reports a hung model list while the version answered', async () => {
      const { http } = fakeContext((call) =>
        call.url.endsWith('/api/version') ? json(200, { version: '0.40.4' }) : hang(call.signal),
      );
      const pending = health(http);
      await vi.advanceTimersByTimeAsync(5_000);
      await expect(pending).resolves.toEqual({
        reachable: true,
        version: '0.40.4',
        models: [],
        error: `Ollama at ${BASE_URL} did not answer within 5000 ms`,
      });
    });
  });
});
