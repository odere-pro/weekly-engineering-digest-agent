import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { LoadedConfig } from '../../../config/load';
import type { Platform } from '../../../config/profiles';
import type { ModelHealth } from '../../../models/ModelProvider';
import { urlOf } from '../__fixtures__/doctorHarness';
import { GIB } from './memory';
import {
  askOllama,
  freeDiskBytes,
  localModelsDir,
  ollamaHealth,
  resolveTarget,
  type ReadinessIo,
} from './target';

const MAC: Platform = { os: 'darwin', arch: 'arm64' };
const LINUX: Platform = { os: 'linux', arch: 'x64' };

function loadedAt(platform: Platform): LoadedConfig {
  return {
    config: { dataDir: '/srv/data', profile: 'light' },
    env: { OLLAMA_URL: 'http://ollama.lan:11434' },
    platform,
  } as unknown as LoadedConfig;
}

function io(overrides: Partial<ReadinessIo> = {}): ReadinessIo {
  return {
    loadConfig: () => Promise.reject(new Error('ENOENT: no config')),
    env: {},
    totalMemoryBytes: 64 * GIB,
    nodeVersion: 'v24.1.0',
    homeDir: '/home/me',
    freeDiskBytes: () => Promise.resolve(GIB),
    ollamaHealth: () => Promise.resolve({ reachable: true, models: [] }),
    stdout: () => undefined,
    ...overrides,
  };
}

describe('resolveTarget', () => {
  it('takes the data folder, Ollama URL and host from a config that loads', async () => {
    const target = await resolveTarget(
      'digest.config.json',
      io({ loadConfig: () => Promise.resolve(loadedAt(LINUX)) }),
    );

    expect(target).toEqual({
      dataDir: '/srv/data',
      ollamaUrl: 'http://ollama.lan:11434',
      platform: LINUX,
      configNote: undefined,
    });
  });

  it('passes the config path, env path and platform to the loader', async () => {
    const loadConfig = vi.fn(() => Promise.resolve(loadedAt(MAC)));

    await resolveTarget('custom.json', io({ loadConfig, envPath: '/x/.env', platform: LINUX }));

    expect(loadConfig).toHaveBeenCalledWith({
      configPath: 'custom.json',
      envPath: '/x/.env',
      platform: LINUX,
    });
  });

  it('prefers the platform in the io over the one on the loaded config', async () => {
    const target = await resolveTarget(
      undefined,
      io({ platform: MAC, loadConfig: () => Promise.resolve(loadedAt(LINUX)) }),
    );

    expect(target.platform).toEqual(MAC);
  });

  it('falls back to the defaults, with a note saying why, when the config does not load', async () => {
    const target = await resolveTarget(undefined, io({ platform: MAC }));

    expect(target).toMatchObject({
      dataDir: 'dist',
      ollamaUrl: 'http://localhost:11434',
      platform: MAC,
      configNote: 'no config used (ENOENT: no config); showing defaults',
    });
  });

  it('reads OLLAMA_URL from the environment when there is no config', async () => {
    const target = await resolveTarget(
      undefined,
      io({ platform: MAC, env: { OLLAMA_URL: 'http://127.0.0.1:9999' } }),
    );

    expect(target.ollamaUrl).toBe('http://127.0.0.1:9999');
  });

  it('ignores an OLLAMA_URL that is not a URL', async () => {
    const target = await resolveTarget(
      undefined,
      io({ platform: MAC, env: { OLLAMA_URL: 'nope' } }),
    );

    expect(target.ollamaUrl).toBe('http://localhost:11434');
  });

  it('reads the host from DIGEST_HOST_OS and DIGEST_HOST_ARCH when there is no config', async () => {
    const target = await resolveTarget(
      undefined,
      io({ env: { DIGEST_HOST_OS: 'Darwin', DIGEST_HOST_ARCH: 'arm64' } }),
    );

    expect(target.platform).toEqual({ os: 'darwin', arch: 'arm64' });
    expect(target.configNote).not.toContain('platform');
  });

  it('reports a bad DIGEST_HOST_OS in the note and uses the platform of this process', async () => {
    const target = await resolveTarget(undefined, io({ env: { DIGEST_HOST_OS: 'macos' } }));

    expect(target.platform).toEqual({ os: process.platform, arch: process.arch });
    expect(target.configNote).toContain("using this process's platform");
  });
});

describe('askOllama', () => {
  it('returns the health the io gives', async () => {
    const health: ModelHealth = { reachable: true, version: '0.40.4', models: [] };
    const ollamaHealthSpy = vi.fn(() => Promise.resolve(health));

    expect(await askOllama('http://h:1', io({ ollamaHealth: ollamaHealthSpy }))).toBe(health);
    expect(ollamaHealthSpy).toHaveBeenCalledWith('http://h:1');
  });

  it('turns a rejection into "not reachable" with the reason', async () => {
    const health = await askOllama(
      'http://h:1',
      io({ ollamaHealth: () => Promise.reject(new Error('boom')) }),
    );

    expect(health).toEqual({ reachable: false, models: [], error: 'boom' });
  });
});

describe('localModelsDir', () => {
  const at = (env: ReadinessIo['env']) => ({ env, homeDir: '/home/me' });

  it.each(['http://localhost:11434', 'http://127.0.0.1:11434', 'http://[::1]:11434'])(
    'is ~/.ollama/models for the local server %s',
    (url) => {
      expect(localModelsDir(url, at({}))).toBe('/home/me/.ollama/models');
    },
  );

  it('is undefined for a server on another host: its folder is not ours to measure', () => {
    expect(localModelsDir('http://ollama.lan:11434', at({}))).toBeUndefined();
  });

  it('takes the folder from OLLAMA_MODELS, resolved and trimmed', () => {
    expect(localModelsDir('http://localhost:11434', at({ OLLAMA_MODELS: ' /big/models ' }))).toBe(
      '/big/models',
    );
    expect(localModelsDir('http://localhost:11434', at({ OLLAMA_MODELS: 'rel/models' }))).toBe(
      resolve('rel/models'),
    );
  });

  it('ignores an OLLAMA_MODELS that is only space', () => {
    expect(localModelsDir('http://localhost:11434', at({ OLLAMA_MODELS: '  ' }))).toBe(
      '/home/me/.ollama/models',
    );
  });
});

describe('freeDiskBytes', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'digest-readiness-'));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('returns the free bytes of the disk that holds an existing folder', async () => {
    const free = await freeDiskBytes(dir);

    expect(free).toBeTypeOf('number');
    expect(free).toBeGreaterThanOrEqual(0);
  });

  it('judges a path that does not exist yet by its nearest existing parent', async () => {
    const free = await freeDiskBytes(join(dir, 'not', 'here', 'yet'));

    expect(free).toBeTypeOf('number');
    expect(free).toBeGreaterThanOrEqual(0);
  });

  it('answers for a file too', async () => {
    await writeFile(join(dir, 'f'), 'x');

    expect(await freeDiskBytes(join(dir, 'f'))).toBeTypeOf('number');
  });
});

describe('ollamaHealth', () => {
  const answer = (body: unknown): Response =>
    new Response(JSON.stringify(body), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });

  it('reads the version and the models, with their capabilities, from the server', async () => {
    const fetchImpl = vi.fn(async (input: string | URL | Request) => {
      return urlOf(input).endsWith('/api/version')
        ? answer({ version: '0.40.4' })
        : answer({
            models: [{ name: 'clef:latest', capabilities: ['decision'] }, { name: 'other:1' }],
          });
    });

    const health = await ollamaHealth('http://ollama.test:11434', fetchImpl);

    expect(health).toEqual({
      reachable: true,
      version: '0.40.4',
      models: [
        { name: 'clef:latest', capabilities: ['decision'] },
        { name: 'other:1', capabilities: [] },
      ],
    });
    expect(fetchImpl.mock.calls.map(([input]) => urlOf(input)).sort()).toEqual([
      'http://ollama.test:11434/api/tags',
      'http://ollama.test:11434/api/version',
    ]);
  });

  it('reports a server that does not answer as not reachable, with no models', async () => {
    const fetchImpl = vi.fn(async () => {
      throw new TypeError('fetch failed');
    });

    const health = await ollamaHealth('http://ollama.test:11434', fetchImpl);

    expect(health.reachable).toBe(false);
    expect(health.models).toEqual([]);
    expect(health.error).toContain('fetch failed');
  });
});
