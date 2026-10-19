import { afterEach, describe, expect, it, vi } from 'vitest';
import { doctorCommand } from './doctor';
import { ATOM_FEED, MAC, MISSING_ENV, urlOf, VALID_CONFIG } from './__fixtures__/doctorHarness';

const answer = (body: unknown): Response =>
  new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });

/** An Ollama with no models, and a feed that answers. */
function fakeNetwork(): typeof fetch {
  return vi.fn(async (input: string | URL | Request) => {
    const url = urlOf(input);
    if (url.endsWith('/api/version')) return answer({ version: '0.40.4' });
    if (url.endsWith('/api/tags')) return answer({ models: [] });
    return new Response(ATOM_FEED, { status: 200 });
  });
}

function captureStdout(): () => string {
  const chunks: string[] = [];
  vi.spyOn(process.stdout, 'write').mockImplementation((chunk: string | Uint8Array) => {
    chunks.push(String(chunk));
    return true;
  });
  return () => chunks.join('');
}

describe('doctorCommand with the default I/O', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('loads the config from disk, reaches Ollama and the feed through global fetch, and prints to stdout', async () => {
    const printed = captureStdout();
    const network = fakeNetwork();
    vi.stubGlobal('fetch', network);

    const code = await doctorCommand(
      { config: VALID_CONFIG },
      { envPath: MISSING_ENV, platform: MAC },
    );

    expect(code).toBe(1); // the fake Ollama has no models, so each model is an error
    expect(printed()).toMatch(/^✓ config: loaded .*valid\.config\.json \(profile \w+\)$/m);
    expect(printed()).toMatch(/^✓ ollama: reachable at \S+, version 0\.40\.4$/m);
    expect(printed()).toContain('✓ source example-feed: reachable and readable');
    expect(printed()).toContain('✗ model clef:latest: not installed');
    expect(network).toHaveBeenCalled();
  });
});
