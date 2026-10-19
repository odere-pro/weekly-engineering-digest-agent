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
  it('maps the version and each model’s capabilities', async () => {
    const { http, calls } = fakeContext(healthy);

    const result = await health(http);

    expect(result).toEqual({
      reachable: true,
      version: '0.40.4',
      models: [
        { name: 'clef:latest', capabilities: ['decision', 'vision'] },
        {
          name: 'gemma4:e4b-mlx',
          capabilities: ['completion', 'vision', 'audio', 'tools', 'thinking'],
        },
        { name: 'strands-decider:2b-mlx-bf16', capabilities: ['decision'] },
      ],
    });
    expect(calls.map((c) => [c.method, c.url]).sort()).toEqual([
      ['GET', `${BASE_URL}/api/tags`],
      ['GET', `${BASE_URL}/api/version`],
    ]);
  });

  it('gives a model without capabilities an empty list', async () => {
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
