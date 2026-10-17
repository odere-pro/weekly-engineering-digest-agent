import { describe, expect, it, vi } from 'vitest';
import {
  compareCore,
  fitsRam,
  formatGiB,
  hasQualityMemory,
  hasRam,
  normalizeTag,
  parseVersion,
  readinessCommand,
  type ReadinessIo,
} from '../../src/cli/readiness.js';
import { NON_MAC_FALLBACK, PROFILES, requiredModels } from '../../src/config/profiles.js';
import type { Platform } from '../../src/config/profiles.js';
import type { ModelHealth } from '../../src/ports/ModelProvider.js';

const GIB = 1024 ** 3;
const MAC: Platform = { os: 'darwin', arch: 'arm64' };
const LINUX: Platform = { os: 'linux', arch: 'x64' };

function installedAll(tags: readonly string[]): ModelHealth['models'] {
  return tags.map((name) => ({ name, capabilities: ['completion'] }));
}

const ALL_TAGS = [
  ...new Set([
    ...requiredModels({ ...PROFILES.quality }),
    ...requiredModels({ ...PROFILES.fast }),
    ...requiredModels({ ...PROFILES.light }),
    ...requiredModels({ ...PROFILES.light, ...NON_MAC_FALLBACK }),
  ]),
];

interface Harness {
  io: Partial<ReadinessIo>;
  out: () => string;
  fetchSpy: ReturnType<typeof vi.fn>;
  health: ReturnType<typeof vi.fn>;
}

function harness(
  setup: {
    platform?: Platform;
    ramGiB?: number;
    health?: Partial<ModelHealth>;
    healthThrows?: boolean;
    config?: 'missing' | 'invalid' | 'valid';
    env?: Record<string, string | undefined>;
    disk?: (path: string) => number | undefined;
  } = {},
): Harness {
  const chunks: string[] = [];
  const fetchSpy = vi.fn(() => Promise.reject(new Error('network must not be used')));
  const health = vi.fn(() => {
    if (setup.healthThrows) return Promise.reject(new Error('boom'));
    return Promise.resolve<ModelHealth>({
      reachable: true,
      version: '0.40.4',
      models: installedAll(ALL_TAGS),
      ...setup.health,
    });
  });
  const config = setup.config ?? 'missing';
  const io: Partial<ReadinessIo> = {
    platform: setup.platform ?? MAC,
    totalMemoryBytes: (setup.ramGiB ?? 64) * GIB,
    nodeVersion: 'v24.1.0',
    env: setup.env ?? {},
    homeDir: '/home/me',
    freeDiskBytes: (path: string) => Promise.resolve((setup.disk ?? (() => 100 * GIB))(path)),
    ollamaHealth: health,
    loadConfig: () => {
      if (config === 'missing') return Promise.reject(new Error('ENOENT: no config'));
      if (config === 'invalid') return Promise.reject(new Error('bad config'));
      return Promise.resolve({
        config: { dataDir: '/srv/data', profile: 'light' },
        env: { OLLAMA_URL: 'http://ollama.lan:11434' },
        platform: setup.platform ?? MAC,
      } as never);
    },
    stdout: (text: string) => chunks.push(text),
  };
  return { io, out: () => chunks.join(''), fetchSpy, health };
}

describe('RAM helpers', () => {
  it('hasRam allows a 5% tolerance below the figure', () => {
    expect(hasRam(32 * GIB * 0.95, 32)).toBe(true);
    expect(hasRam(32 * GIB * 0.95 - 1, 32)).toBe(false);
  });

  it('hasQualityMemory is hasRam for 32 GiB', () => {
    expect(hasQualityMemory(32 * GIB)).toBe(true);
    expect(hasQualityMemory(16 * GIB)).toBe(false);
  });

  it('formatGiB prints one decimal', () => {
    expect(formatGiB(1.5 * GIB)).toBe('1.5 GiB');
  });

  it('fitsRam knows quality (32) and light (16); the rest get a 16 GiB floor, marked unmeasured', () => {
    expect(fitsRam('quality', 31 * GIB)).toBe('yes');
    expect(fitsRam('quality', 16 * GIB)).toBe('no');
    expect(fitsRam('light', 16 * GIB)).toBe('yes');
    expect(fitsRam('light', 8 * GIB)).toBe('no');
    expect(fitsRam('fast', 8 * GIB)).toBe('no');
    expect(fitsRam('fast', 16 * GIB)).toBe('maybe');
    expect(fitsRam('fallback', 8 * GIB)).toBe('no');
    expect(fitsRam('fallback', 64 * GIB)).toBe('maybe');
  });
});

describe('version helpers', () => {
  it('parses plain, v-prefixed and pre-release versions', () => {
    expect(parseVersion('0.40.4')?.core).toEqual([0, 40, 4]);
    expect(parseVersion('v1.2.3')?.core).toEqual([1, 2, 3]);
    expect(parseVersion('0.40.0-rc1')?.prerelease).toBe(true);
    expect(parseVersion('0.40.0')?.prerelease).toBe(false);
    expect(parseVersion('nonsense')).toBeUndefined();
  });

  it('compares cores', () => {
    expect(compareCore([0, 40, 0], [0, 40, 0])).toBe(0);
    expect(compareCore([0, 39, 9], [0, 40, 0])).toBeLessThan(0);
    expect(compareCore([1, 0, 0], [0, 40, 0])).toBeGreaterThan(0);
  });

  it('normalizeTag adds :latest to an untagged name only', () => {
    expect(normalizeTag('clef')).toBe('clef:latest');
    expect(normalizeTag('clef:latest')).toBe('clef:latest');
    expect(normalizeTag('host:5000/x')).toBe('host:5000/x:latest');
  });
});

const h0 = { fetchSpy: vi.fn() };

describe('readinessCommand', () => {
  it('lists every profile and the fallback with a verdict', async () => {
    const h = harness();
    const code = await readinessCommand({}, h.io);
    const text = h.out();
    for (const name of ['quality', 'fast', 'light', 'fallback']) expect(text).toContain(name);
    expect(text).toContain('ready');
    expect(code).toBe(0);
  });

  it('prints the machine summary', async () => {
    const h = harness({ disk: (path) => (path.includes('.ollama') ? 50 * GIB : 120 * GIB) });
    await readinessCommand({}, h.io);
    const text = h.out();
    expect(text).toContain('darwin');
    expect(text).toContain('arm64');
    expect(text).toMatch(/Apple silicon:\s+yes/);
    expect(text).toContain('64.0 GiB');
    expect(text).toContain('120.0 GiB');
    expect(text).toContain('50.0 GiB');
    expect(text).toContain('v24.1.0');
    expect(text).toContain('0.40.4');
    expect(text).toContain('http://localhost:11434');
  });

  it('is ready when everything is installed on a big Mac', async () => {
    const h = harness();
    await readinessCommand({}, h.io);
    expect(h.out()).not.toContain('ollama pull');
    expect(h.out()).not.toContain('not for this machine');
  });

  it('says "pull models" and prints the pull lines for the missing tags', async () => {
    const h = harness({ health: { models: installedAll(['clef:latest']) } });
    const code = await readinessCommand({}, h.io);
    const text = h.out();
    expect(text).toContain('pull models');
    expect(text).toContain('ollama pull gemma4:e4b-mlx');
    expect(text).not.toContain('ollama pull clef:latest');
    expect(code).toBe(0);
  });

  it('counts installed models as N of M', async () => {
    const h = harness({ health: { models: installedAll(['clef:latest']) } });
    await readinessCommand({}, h.io);
    expect(h.out()).toContain(`1 of ${String(requiredModels(PROFILES.quality).length)}`);
  });

  it('matches an untagged installed name to its :latest tag', async () => {
    const h = harness({ health: { models: installedAll(['clef']) } });
    await readinessCommand({}, h.io);
    expect(h.out()).not.toContain('ollama pull clef:latest');
  });

  it('marks Apple-silicon profiles not for this machine on Linux, and the fallback usable', async () => {
    const h = harness({ platform: LINUX });
    const code = await readinessCommand({}, h.io);
    const lines = h.out().split('\n');
    expect(code).toBe(0);
    for (const name of ['quality', 'fast', 'light']) {
      const line = lines.find((l) => l.trimStart().startsWith(name));
      expect(line).toContain('not for this machine');
    }
    const fallback = lines.find((l) => l.trimStart().startsWith('fallback'));
    expect(fallback).toContain('ready');
    expect(code).toBe(0);
  });

  it('marks quality not for this machine when RAM is short', async () => {
    const h = harness({ ramGiB: 16 });
    await readinessCommand({}, h.io);
    const quality = h
      .out()
      .split('\n')
      .find((l) => l.trimStart().startsWith('quality'));
    expect(quality).toContain('not for this machine');
    const light = h
      .out()
      .split('\n')
      .find((l) => l.trimStart().startsWith('light'));
    expect(light).toContain('ready');
  });

  it('exits 1 when every row is not for this machine', async () => {
    const h = harness({ ramGiB: 8 });
    const code = await readinessCommand({}, h.io);
    expect(code).toBe(1);
    expect(h.out()).not.toContain('ready');
    expect(h.out()).toContain('not for this machine');
  });

  it('exits 1 on Linux with 8 GiB: the fallback does not fit either', async () => {
    expect(await readinessCommand({}, harness({ platform: LINUX, ramGiB: 8 }).io)).toBe(1);
  });

  it('flags an Ollama older than the minimum and still returns the pull list', async () => {
    const h = harness({ health: { version: '0.30.0' } });
    await readinessCommand({}, h.io);
    expect(h.out()).toMatch(/too old/);
    expect(h.out()).toContain('pull models');
  });

  it('uses a lower minimum for the fallback', async () => {
    const h = harness({ platform: LINUX, health: { version: '0.36.0' } });
    await readinessCommand({}, h.io);
    const fallback = h
      .out()
      .split('\n')
      .find((l) => l.trimStart().startsWith('fallback'));
    expect(fallback).toContain('ready');
  });

  it('reports an unreachable Ollama without crashing', async () => {
    const h = harness({ health: { reachable: false, error: 'connection refused', models: [] } });
    const code = await readinessCommand({}, h.io);
    expect(h.out()).toContain('not reachable');
    expect(h.out()).toContain('connection refused');
    expect(h.out()).toContain('ollama pull');
    expect(code).toBe(0);
  });

  it('treats a throwing health call as unreachable', async () => {
    const h = harness({ healthThrows: true });
    await readinessCommand({}, h.io);
    expect(h.out()).toContain('not reachable');
  });

  it('reports a failure listing models as unreachable models', async () => {
    const h = harness({ health: { error: 'tags failed', models: [] } });
    await readinessCommand({}, h.io);
    expect(h.out()).toContain('tags failed');
  });

  it('accepts a missing version, an unreadable one and a development build', async () => {
    for (const version of [undefined, 'weird', '0.0.0']) {
      const h = harness({ health: { version } });
      await readinessCommand({}, h.io);
      expect(h.out()).toContain('unknown');
    }
  });

  it('works without a config file and says so', async () => {
    const h = harness({ config: 'missing' });
    await readinessCommand({}, h.io);
    expect(h.out()).toContain('no config');
    expect(h.out()).toContain('data');
  });

  it('works with an invalid config file and says so', async () => {
    const h = harness({ config: 'invalid' });
    const code = await readinessCommand({}, h.io);
    expect(h.out()).toContain('bad config');
    expect(code).toBe(0);
  });

  it('uses the loaded config dataDir and Ollama URL when there is one', async () => {
    const seen: string[] = [];
    const h = harness({
      config: 'valid',
      disk: (path) => {
        seen.push(path);
        return GIB;
      },
    });
    await readinessCommand({}, h.io);
    expect(seen.some((p) => p.endsWith('/srv/data'))).toBe(true);
    expect(h.health).toHaveBeenCalledWith('http://ollama.lan:11434');
    // A remote Ollama: its models dir is not on this machine.
    expect(seen.some((p) => p.includes('.ollama'))).toBe(false);
  });

  it('reads OLLAMA_URL from the environment when there is no config', async () => {
    const h = harness({ env: { OLLAMA_URL: 'http://127.0.0.1:9999' } });
    await readinessCommand({}, h.io);
    expect(h.health).toHaveBeenCalledWith('http://127.0.0.1:9999');
  });

  it('ignores a bad OLLAMA_URL in the environment', async () => {
    const h = harness({ env: { OLLAMA_URL: 'not a url' } });
    await readinessCommand({}, h.io);
    expect(h.health).toHaveBeenCalledWith('http://localhost:11434');
  });

  it('takes the Ollama models dir from OLLAMA_MODELS, else ~/.ollama/models', async () => {
    const seen: string[] = [];
    const record = (path: string): number => {
      seen.push(path);
      return GIB;
    };
    await readinessCommand({}, harness({ env: { OLLAMA_MODELS: '/big/models' }, disk: record }).io);
    expect(seen).toContain('/big/models');
    seen.length = 0;
    await readinessCommand({}, harness({ disk: record }).io);
    expect(seen).toContain('/home/me/.ollama/models');
  });

  it('prints "unknown" when the free disk cannot be read', async () => {
    const h = harness({ disk: () => undefined });
    await readinessCommand({}, h.io);
    expect(h.out()).toMatch(/Free disk.*unknown/);
  });

  it('uses DIGEST_HOST_OS and DIGEST_HOST_ARCH when no platform is given', async () => {
    const h = harness({ env: { DIGEST_HOST_OS: 'Darwin', DIGEST_HOST_ARCH: 'arm64' } });
    delete h.io.platform;
    await readinessCommand({}, h.io);
    expect(h.out()).toMatch(/Apple silicon:\s+yes/);
  });

  it('takes the platform from the loaded config when none is given', async () => {
    const h = harness({ config: 'valid', platform: LINUX });
    delete h.io.platform;
    await readinessCommand({}, h.io);
    expect(h.out()).toMatch(/Apple silicon:\s+no/);
  });

  it('never calls fetch for feeds or delivery', async () => {
    vi.stubGlobal('fetch', h0.fetchSpy);
    const h = harness();
    await readinessCommand({}, h.io);
    expect(h0.fetchSpy).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });

  it('strips credentials from the Ollama URL and error text', async () => {
    const h = harness({
      env: { OLLAMA_URL: 'http://user:tok3n@gpu:11434' },
      health: { reachable: false, models: [], error: 'no answer from http://user:tok3n@gpu:11434' },
    });
    await readinessCommand({}, h.io);
    expect(h.out()).not.toContain('tok3n');
    expect(h.out()).toContain('http://gpu:11434');
  });

  it('reports a bad DIGEST_HOST_OS instead of throwing', async () => {
    const h = harness({ env: { DIGEST_HOST_OS: 'macos' } });
    delete h.io.platform;
    const code = await readinessCommand({}, h.io);
    expect(h.out()).toContain("this process's platform");
    expect(typeof code).toBe('number');
  });
});
