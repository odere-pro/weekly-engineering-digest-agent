import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { fetchCommand, type FetchCommandDeps } from './fetch';
import {
  defaultRoutes,
  harness,
  pathsIn,
  serving,
  useTempDir,
  type Harness,
} from './__fixtures__/fetchHarness';

// What `fetchCommand` does with the output, fetch and config loader it is not given: `digest fetch`
// runs with all of them.

const dir = useTempDir();

afterEach(() => {
  vi.unstubAllGlobals();
});

/** The harness, and its deps without the ones under test. */
async function withoutDeps(
  ...names: (keyof FetchCommandDeps)[]
): Promise<{ h: Harness; deps: Partial<FetchCommandDeps> }> {
  const h = await harness(dir());
  const left = new Set<string>(names);
  const kept = Object.entries(h.deps).filter(([name]) => !left.has(name));
  return { h, deps: Object.fromEntries(kept) };
}

describe('fetchCommand: default output, fetch and loader', () => {
  it('prints the table and where the files are to the process stdout', async () => {
    const written: string[] = [];
    vi.spyOn(process.stdout, 'write').mockImplementation((text) => {
      written.push(String(text));
      return true;
    });
    const { deps } = await withoutDeps('stdout');

    const code = await fetchCommand({}, deps);

    expect(code).toBe(0);
    const out = written.join('');
    expect(out).toContain('example-feed');
    expect(out).toContain(`Saved to ${pathsIn(dir()).runFolder}`);
  });

  it('prints why it failed to the process stderr', async () => {
    const written: string[] = [];
    vi.spyOn(process.stderr, 'write').mockImplementation((text) => {
      written.push(String(text));
      return true;
    });
    const { h, deps } = await withoutDeps('stderr');

    const code = await fetchCommand({ since: 'soon' }, deps);

    expect(code).toBe(1);
    expect(written.join('')).toContain('Invalid --since "soon"');
    expect(h.loadConfig).not.toHaveBeenCalled();
  });

  it('reads the requests through the global fetch, looked up when the command runs', async () => {
    const served = serving(await defaultRoutes());
    vi.stubGlobal('fetch', served.fetch);
    const { deps } = await withoutDeps('fetch');

    const code = await fetchCommand({}, deps);

    expect(code).toBe(0);
    expect(served.calls.map((call) => call.url)).toEqual(['https://example.com/feed.xml']);
  });

  it('loads the config from the path of --config with the real loader', async () => {
    // The loader reads the config file first and stops at a missing one, so no `.env` is read.
    const { h, deps } = await withoutDeps('loadConfig');
    const missing = join(dir(), 'missing.json');

    const code = await fetchCommand({ config: missing }, deps);

    expect(code).toBe(1);
    expect(h.err()).toContain(`No digest.config.json found at ${missing}`);
    expect(h.calls).toEqual([]);
  });
});
