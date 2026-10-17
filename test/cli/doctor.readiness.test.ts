import { describe, expect, it, vi } from 'vitest';
import { doctorCommand } from '../../src/cli/doctor.js';
import type { ModelHealth } from '../../src/ports/ModelProvider.js';

const GIB = 1024 ** 3;

function run(readiness: boolean | undefined, health: Partial<ModelHealth> = {}) {
  const out: string[] = [];
  const loadConfig = vi.fn(() => Promise.reject(new Error('ENOENT: no config')));
  const createProvider = vi.fn();
  const fetch = vi.fn();
  const ollamaHealth = vi.fn(() =>
    Promise.resolve<ModelHealth>({ reachable: true, version: '0.40.4', models: [], ...health }),
  );
  const code = doctorCommand(
    { readiness },
    {
      loadConfig,
      createProvider,
      fetch: fetch as unknown as typeof globalThis.fetch,
      platform: { os: 'darwin', arch: 'arm64' },
      stdout: (text) => out.push(text),
      readiness: {
        env: {},
        totalMemoryBytes: 64 * GIB,
        nodeVersion: 'v24.0.0',
        homeDir: '/home/me',
        freeDiskBytes: () => Promise.resolve(10 * GIB),
        ollamaHealth,
      },
    },
  );
  return { code, out, createProvider, fetch, loadConfig };
}

describe('doctor --readiness', () => {
  it('prints the readiness report and not the checks', async () => {
    const r = run(true);
    expect(await r.code).toBe(0);
    const text = r.out.join('');
    expect(text).toContain('Machine');
    expect(text).toContain('fallback');
    expect(text).not.toContain('Doctor:');
    expect(r.createProvider).not.toHaveBeenCalled();
    expect(r.fetch).not.toHaveBeenCalled();
  });

  it('exits 1 when no profile can run here', async () => {
    const out: string[] = [];
    const code = await doctorCommand(
      { readiness: true },
      {
        loadConfig: () => Promise.reject(new Error('ENOENT')),
        platform: { os: 'linux', arch: 'x64' },
        stdout: (t) => out.push(t),
        readiness: {
          env: {},
          totalMemoryBytes: 4 * GIB,
          nodeVersion: 'v24.0.0',
          homeDir: '/h',
          freeDiskBytes: () => Promise.resolve(undefined),
          ollamaHealth: () => Promise.resolve({ reachable: false, models: [] }),
        },
      },
    );
    expect(code).toBe(1);
  });

  it('runs the normal checks without the flag', async () => {
    const r = run(undefined);
    expect(await r.code).toBe(1);
    expect(r.out.join('')).toContain('config');
    expect(r.out.join('')).not.toContain('Machine');
  });
});
