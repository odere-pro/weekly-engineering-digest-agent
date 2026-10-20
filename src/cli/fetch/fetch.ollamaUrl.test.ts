import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { fetchCommand } from './fetch';
import { RSS, allFiles, harness, useTempDir, type Harness } from './__fixtures__/fetchHarness';

const dir = useTempDir();

const OLLAMA_URL = 'http://ollama-user:pa%40ss-ollama-9d2@ollama.test:11434';
/** The password as written in the URL, and decoded as a proxy or a library would echo it. */
const PASSWORDS = ['pa%40ss-ollama-9d2', 'pa@ss-ollama-9d2'];

describe('fetchCommand: a password inside OLLAMA_URL', () => {
  it('never reaches stdout, the saved summary or any file from a source error', async () => {
    const h = await harness(dir(), {
      env: { OLLAMA_URL },
      routes: { [RSS.url]: new Error(`proxy to ${OLLAMA_URL} refused, token pa@ss-ollama-9d2`) },
    });

    const code = await fetchCommand({}, h.deps);

    expect(code).toBe(1);
    expect(h.out()).toContain('[redacted]');
    await expectNoPassword(h);
  });

  it('never reaches stderr from an error the command throws', async () => {
    const h = await harness(dir(), { env: { OLLAMA_URL } });
    const clock = {
      now: (): Date => {
        throw new Error('clock failed after pa@ss-ollama-9d2');
      },
    };

    const code = await fetchCommand({}, { ...h.deps, clock });

    expect(code).toBe(1);
    expect(h.err()).toBe('clock failed after [redacted]\n');
    await expectNoPassword(h);
  });
});

async function expectNoPassword(h: Harness): Promise<void> {
  const files = await Promise.all(
    (await allFiles(h.dir)).map((file) => readFile(join(h.dir, file), 'utf8')),
  );
  const everything = [h.out(), h.err(), ...files].join('\n');
  for (const password of PASSWORDS) {
    expect(everything).not.toContain(password);
  }
}
