import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import { effectiveThink } from '../../src/adapters/models/ollama.js';
import { doctorCommand, type DoctorIo } from '../../src/cli/doctor.js';
import { loadConfig, type LoadedConfig } from '../../src/config/load.js';
import {
  modelsInUse,
  PROFILES,
  requiredModels,
  resolveProfile,
  type ModelProfile,
  type Platform,
} from '../../src/config/profiles.js';
import type { ConfigInput, Secrets } from '../../src/config/schema.js';
import { DigestError } from '../../src/shared/errors.js';
import type { ModelHealth } from '../../src/ports/ModelProvider.js';
import { makeConfig } from '../builders.js';
import { FakeModelProvider, fixedClock } from '../fakes/index.js';

const MAC: Platform = { os: 'darwin', arch: 'arm64' };
const LINUX: Platform = { os: 'linux', arch: 'x64' };
const CONFIG_FIXTURES = join(import.meta.dirname, '..', 'fixtures', 'config');
const VALID_CONFIG = join(CONFIG_FIXTURES, 'valid.config.json');
const MISSING_ENV = join(CONFIG_FIXTURES, 'missing.env');
const DATA_DIR = '/srv/digest/data';
const ENV_PATH = '/srv/digest/.env';
const FEED_URL = 'https://example.com/feed.xml';
const GITHUB_URL = 'https://github.com/acme/tool';
const ATOM_FEED =
  '<?xml version="1.0"?><feed xmlns="http://www.w3.org/2005/Atom"><title>t</title><id>t</id>' +
  '<updated>2026-10-15T00:00:00Z</updated><entry><title>v1</title><id>a</id>' +
  '<link href="https://github.com/acme/tool/releases/tag/v1"/><updated>2026-10-15T00:00:00Z</updated></entry></feed>';

/** Tags that must be decision models for a profile: classify, guardPolicy and the judge. */
function decisionTags(profile: ModelProfile): string[] {
  return [profile.classify, profile.guardPolicy, ...(profile.judge ? [profile.judge] : [])];
}

function installedFor(profile: ModelProfile, skip: readonly string[] = []): ModelHealth['models'] {
  const decision = new Set(decisionTags(profile));
  return requiredModels(profile)
    .filter((tag) => !skip.includes(tag))
    .map((name) => ({ name, capabilities: decision.has(name) ? ['decision'] : ['completion'] }));
}

function urlOf(input: string | URL | Request): string {
  if (typeof input === 'string') return input;
  return input instanceof URL ? input.href : input.url;
}

function errnoError(code: string): Error {
  return Object.assign(new Error(`${code}: simulated`), { code });
}

/** What is on the fake disk at a path. */
type FsEntry =
  | { kind: 'dir'; writable?: boolean }
  | { kind: 'file'; mode?: number; writable?: boolean; content?: string }
  | { kind: 'symlink'; target: string };

interface Setup {
  config?: Partial<ConfigInput>;
  secrets?: Secrets;
  /** Profile the loader resolved; defaults to the configured profile for `platform`. */
  profile?: ModelProfile;
  platform?: Platform;
  /**
   * DIGEST_HOST_OS/DIGEST_HOST_ARCH as the loader read them. The io then carries no platform,
   * as in production, so the command judges the one on the loaded config.
   */
  hostEnv?: Pick<LoadedConfig['env'], 'DIGEST_HOST_OS' | 'DIGEST_HOST_ARCH'>;
  /** The platform the loader reports on the loaded config (`LoadedConfig.platform`). */
  loadedPlatform?: Platform;
  health?: Partial<ModelHealth> | ((profile: ModelProfile) => Partial<ModelHealth>);
  /** Mode of the .env file; null when there is no .env. */
  envMode?: number | null;
  envStatError?: Error;
  /** Text of the .env file. */
  envText?: string;
  /** Makes reading the .env file fail. */
  envReadError?: Error;
  /** Directories that exist; others are missing (ENOENT). */
  existingDirs?: readonly string[];
  /** Directories that exist but are not writable. */
  readOnlyDirs?: readonly string[];
  /** More things on the fake disk, or replacements for the ones above. */
  fs?: Readonly<Record<string, FsEntry>>;
  fetch?: typeof fetch;
  loadConfig?: DoctorIo['loadConfig'];
  sourceTimeoutMs?: number;
}

interface Harness {
  io: Partial<DoctorIo>;
  text: () => string;
  fetch: ReturnType<typeof vi.fn>;
  loadConfig: Mock<DoctorIo['loadConfig']>;
  health: ReturnType<typeof vi.fn>;
}

function okFetch(): typeof fetch {
  return vi.fn(async () => new Response(ATOM_FEED, { status: 200 }));
}

function fakeDisk(setup: Setup): Map<string, FsEntry> {
  const disk = new Map<string, FsEntry>();
  for (const dir of setup.existingDirs ?? ['/', '/srv', '/srv/digest', DATA_DIR]) {
    disk.set(dir, { kind: 'dir' });
  }
  for (const dir of setup.readOnlyDirs ?? []) disk.set(dir, { kind: 'dir', writable: false });
  if (setup.envMode !== null) {
    disk.set(ENV_PATH, {
      kind: 'file',
      mode: setup.envMode ?? 0o600,
      content: setup.envText ?? '',
    });
  }
  for (const [path, entry] of Object.entries(setup.fs ?? {})) disk.set(path, entry);
  return disk;
}

const MAX_LINKS = 8;

/** Where a symbolic link ends up; throws ENOENT for a dangling one, like stat does. */
function follow(disk: ReadonlyMap<string, FsEntry>, path: string): FsEntry {
  let entry = disk.get(path);
  for (let hops = 0; entry?.kind === 'symlink'; hops += 1) {
    if (hops > MAX_LINKS) throw errnoError('ELOOP');
    entry = disk.get(entry.target);
  }
  if (!entry) throw errnoError('ENOENT');
  return entry;
}

function pathInfo(entry: FsEntry): { mode: number; isDirectory: boolean; isSymbolicLink: boolean } {
  switch (entry.kind) {
    case 'dir':
      return { mode: 0o040755, isDirectory: true, isSymbolicLink: false };
    case 'file':
      return { mode: 0o100000 | (entry.mode ?? 0o600), isDirectory: false, isSymbolicLink: false };
    case 'symlink':
      return { mode: 0o120777, isDirectory: false, isSymbolicLink: true };
  }
}

function harness(setup: Setup = {}): Harness {
  const platform = setup.platform ?? MAC;
  const config = makeConfig({ dataDir: DATA_DIR, ...setup.config });
  const profile = setup.profile ?? resolveProfile(config.profile, platform, config.models.writers);
  const loaded: LoadedConfig = {
    config,
    env: { OLLAMA_URL: 'http://localhost:11434', LOG_LEVEL: 'info', ...setup.hostEnv },
    secrets: setup.secrets ?? {},
    profile,
    configPath: '/srv/digest/digest.config.json',
    platform: setup.loadedPlatform ?? platform,
  };
  const healthOverride =
    typeof setup.health === 'function' ? setup.health(profile) : (setup.health ?? {});
  const health: ModelHealth = {
    reachable: true,
    version: '0.40.4',
    models: installedFor(profile),
    ...healthOverride,
  };
  const provider = new FakeModelProvider({ health });
  const healthSpy = vi.spyOn(provider, 'health');
  const fetchSpy = vi.fn(setup.fetch ?? okFetch());
  const loadSpy = vi.fn<DoctorIo['loadConfig']>(setup.loadConfig ?? (async () => loaded));
  const disk = fakeDisk(setup);
  const out: string[] = [];
  const io: Partial<DoctorIo> = {
    loadConfig: loadSpy,
    createProvider: () => provider,
    fetch: fetchSpy,
    clock: fixedClock('2026-10-16T09:00:00Z'),
    ...(setup.hostEnv ? {} : { platform }),
    envPath: ENV_PATH,
    stat: async (path) => {
      if (setup.envStatError && path === ENV_PATH) throw setup.envStatError;
      return pathInfo(follow(disk, path));
    },
    lstat: async (path) => {
      const entry = disk.get(path);
      if (!entry) throw errnoError('ENOENT');
      return pathInfo(entry);
    },
    readFile: async (path) => {
      if (setup.envReadError && path === ENV_PATH) throw setup.envReadError;
      const entry = disk.get(path);
      if (entry?.kind !== 'file') throw errnoError('ENOENT');
      return entry.content ?? '';
    },
    access: async (path) => {
      const entry = follow(disk, path);
      if (entry.kind !== 'symlink' && entry.writable === false) throw errnoError('EACCES');
    },
    sourceTimeoutMs: setup.sourceTimeoutMs ?? 200,
    stdout: (text) => {
      out.push(text);
    },
  };
  return {
    io,
    text: () => out.join(''),
    fetch: fetchSpy,
    loadConfig: loadSpy,
    health: healthSpy,
  };
}

/** The result line that starts with `symbol` and mentions `fragment`, plus its fix line. */
function resultFor(text: string, symbol: '✓' | '!' | '✗', fragment: string): string | undefined {
  const lines = text.split('\n');
  const index = lines.findIndex((line) => line.startsWith(`${symbol} `) && line.includes(fragment));
  if (index < 0) return undefined;
  const next = lines[index + 1] ?? '';
  return next.trimStart().startsWith('fix:') ? `${lines[index]}\n${next}` : lines[index];
}

/** Runs `run` while `process` claims to be `platform`; the real values come back afterwards. */
async function onProcess<T>(platform: Platform, run: () => Promise<T>): Promise<T> {
  const saved = {
    platform: Object.getOwnPropertyDescriptor(process, 'platform'),
    arch: Object.getOwnPropertyDescriptor(process, 'arch'),
  };
  Object.defineProperty(process, 'platform', { value: platform.os, configurable: true });
  Object.defineProperty(process, 'arch', { value: platform.arch, configurable: true });
  try {
    return await run();
  } finally {
    if (saved.platform) Object.defineProperty(process, 'platform', saved.platform);
    if (saved.arch) Object.defineProperty(process, 'arch', saved.arch);
  }
}

async function runDoctor(setup: Setup = {}): Promise<{ code: number; text: string; h: Harness }> {
  const h = harness(setup);
  const code = await doctorCommand({}, h.io);
  return { code, text: h.text(), h };
}

describe('doctorCommand', () => {
  describe('all green', () => {
    it('returns 0 and prints only ✓ results for a healthy machine', async () => {
      const { code, text } = await runDoctor();

      expect(code).toBe(0);
      expect(text).toContain('✓');
      expect(text).not.toMatch(/^[!✗] /m);
      expect(text).toContain('all checks passed');
    });

    it('checks every part of the contract once', async () => {
      const { text } = await runDoctor({
        config: {
          sources: [
            { id: 'example-feed', kind: 'rss', url: FEED_URL },
            { id: 'acme-tool', kind: 'github', url: GITHUB_URL },
          ],
        },
      });

      for (const label of [
        'config',
        'ollama',
        'ollama version',
        'apple silicon',
        'model clef:latest',
        'model gemma4:31b-mlx',
        'model granite4.1-guardian:8b',
        'source example-feed',
        'source acme-tool',
        'markdown',
        '.env',
        'guards',
        'data dir',
      ]) {
        expect(resultFor(text, '✓', `${label}:`), label).toBeDefined();
      }
    });

    it('passes the config path and platform to the loader', async () => {
      const h = harness();

      await doctorCommand({ config: 'custom.config.json' }, h.io);

      expect(h.loadConfig).toHaveBeenCalledWith({
        configPath: 'custom.config.json',
        envPath: ENV_PATH,
        platform: MAC,
      });
    });
  });

  describe('config', () => {
    it('prints ✗ with a fix, returns 1 and runs nothing else when the config does not load', async () => {
      const h = harness({
        loadConfig: async () => {
          throw new DigestError('No digest.config.json found at /x. Run "digest init" first.');
        },
      });

      const code = await doctorCommand({}, h.io);

      expect(code).toBe(1);
      expect(resultFor(h.text(), '✗', 'config:')).toMatch(
        /No digest\.config\.json found.*\n\s+fix: .*digest init/,
      );
      expect(h.health).not.toHaveBeenCalled();
      expect(h.fetch).not.toHaveBeenCalled();
    });

    it('reports a non-DigestError load failure instead of crashing', async () => {
      const { code, text } = await runDoctor({
        loadConfig: async () => {
          throw new TypeError('boom');
        },
      });

      expect(code).toBe(1);
      expect(resultFor(text, '✗', 'config:')).toContain('boom');
    });
  });

  describe('ollama', () => {
    it('prints ✗ with a fix when Ollama is not reachable and skips the model checks', async () => {
      const { code, text } = await runDoctor({
        health: {
          reachable: false,
          models: [],
          error: 'Ollama is not reachable at http://localhost:11434.',
        },
      });

      expect(code).toBe(1);
      expect(resultFor(text, '✗', 'ollama:')).toMatch(
        /not reachable.*\n\s+fix: .*ollama serve.*OLLAMA_URL/,
      );
      expect(text).not.toContain('model clef:latest');
      expect(text).not.toContain('ollama version');
    });

    it('prints ✗ when Ollama answers but cannot list its models', async () => {
      const { code, text } = await runDoctor({
        health: { models: [], error: 'GET /api/tags failed with HTTP 500' },
      });

      expect(code).toBe(1);
      expect(resultFor(text, '✗', 'ollama:')).toMatch(
        /HTTP 500.*\n\s+fix: check the Ollama server log/,
      );
      expect(text).not.toContain('model clef:latest');
    });

    it('prints ✗ with an upgrade fix when the version is older than the profile minimum', async () => {
      const { code, text } = await runDoctor({
        config: { profile: 'fast' },
        health: { version: '0.39.9' },
      });

      expect(code).toBe(1);
      expect(resultFor(text, '✗', 'ollama version:')).toMatch(
        /0\.39\.9.*0\.40\.0.*\n\s+fix: .*(update|upgrade).*Ollama/i,
      );
    });

    it('compares versions numerically, not as text', async () => {
      const old = await runDoctor({ health: { version: '0.9.0' } });
      const newer = await runDoctor({
        config: { profile: 'fast' },
        health: { version: '0.100.1' },
      });

      expect(resultFor(old.text, '✗', 'ollama version:')).toBeDefined();
      expect(resultFor(newer.text, '✓', 'ollama version:')).toBeDefined();
    });

    it('accepts exactly the minimum version, a "v" prefix and build metadata', async () => {
      for (const version of ['0.40.0', 'v0.40.2', '0.40.0+build5']) {
        const { text } = await runDoctor({ health: { version } });

        expect(resultFor(text, '✓', 'ollama version:'), version).toBeDefined();
      }
    });

    it('accepts a pre-release of a version newer than the minimum', async () => {
      const { code, text } = await runDoctor({ health: { version: '0.41.0-rc1' } });

      expect(code).toBe(0);
      expect(resultFor(text, '✓', 'ollama version:')).toContain('0.41.0-rc1');
    });

    it('warns about a pre-release of the minimum itself: it may lack what the release added', async () => {
      const { code, text } = await runDoctor({ health: { version: '0.40.0-rc2' } });

      expect(code).toBe(0);
      expect(resultFor(text, '!', 'ollama version:')).toMatch(
        /0\.40\.0-rc2.*pre-release.*0\.40\.0.*\n\s+fix: install Ollama 0\.40\.0 or later/,
      );
    });

    it('fails a pre-release of a version older than the minimum', async () => {
      const { code, text } = await runDoctor({ health: { version: '0.39.9-rc1' } });

      expect(code).toBe(1);
      expect(resultFor(text, '✗', 'ollama version:')).toContain('0.39.9-rc1');
    });

    it.each(['0.0.0', '0.0.0-dev', 'v0.0.0'])(
      'warns, not fails, for %s, which is how a development build reports itself',
      async (version) => {
        const { code, text } = await runDoctor({ health: { version } });

        expect(code).toBe(0);
        expect(resultFor(text, '!', 'ollama version:')).toMatch(
          /development build.*cannot be checked.*\n\s+fix: /,
        );
        expect(text).not.toContain('older than');
      },
    );

    it('prints ! when the version cannot be read', async () => {
      const { code, text } = await runDoctor({ health: { version: 'dev-build' } });

      expect(code).toBe(0);
      expect(resultFor(text, '!', 'ollama version:')).toContain('dev-build');
    });

    it('prints ! when Ollama reports no version', async () => {
      const { code, text } = await runDoctor({ health: { version: undefined } });

      expect(code).toBe(0);
      expect(resultFor(text, '!', 'ollama version:')).toBeDefined();
    });
  });

  describe('apple silicon', () => {
    it('prints ✗ when the profile in use needs Apple silicon and the machine lacks it', async () => {
      const { code, text } = await runDoctor({ platform: LINUX, profile: PROFILES.quality });

      expect(code).toBe(1);
      expect(resultFor(text, '✗', 'apple silicon:')).toMatch(/\n\s+fix: /);
    });

    it('prints ! when a profile that needs Apple silicon fell back to the untuned profile', async () => {
      const { code, text } = await runDoctor({ platform: LINUX });

      expect(resultFor(text, '!', 'apple silicon:')).toMatch(/fall(s|ing)? back.*\n\s+fix: /i);
      expect(resultFor(text, '✓', 'model gemma4:31b:')).toBeDefined();
      expect(code).toBe(0);
    });

    it('warns that light becomes the heavy fallback off a Mac, and needs far more than 16 GB', async () => {
      const { code, text } = await runDoctor({ platform: LINUX, config: { profile: 'light' } });

      const line = resultFor(text, '!', 'apple silicon:');
      expect(line).toContain('profile light');
      expect(line).toContain('linux/x64');
      expect(line).toContain('clef:latest');
      expect(line).toContain('gemma4:31b');
      expect(line).toMatch(/much more than the 16 GB/);
      expect(line).toMatch(/\n\s+fix: /);
      expect(code).toBe(0);
    });

    it('does not talk about 16 GB for the other profiles that fall back', async () => {
      const { text } = await runDoctor({ platform: LINUX, config: { profile: 'fast' } });

      const line = resultFor(text, '!', 'apple silicon:');
      expect(line).toContain('falls back');
      expect(line).not.toContain('16 GB');
    });

    it('says nothing about the fallback for light on Apple silicon', async () => {
      const { text } = await runDoctor({ platform: MAC, config: { profile: 'light' } });

      expect(resultFor(text, '✓', 'apple silicon:')).toBeDefined();
      expect(text).not.toContain('16 GB');
    });

    it('prints ✓ on Apple silicon', async () => {
      const { text } = await runDoctor({ platform: MAC });

      expect(resultFor(text, '✓', 'apple silicon:')).toBeDefined();
    });

    it('reports an Intel Mac as not Apple silicon', async () => {
      const { text } = await runDoctor({
        platform: { os: 'darwin', arch: 'x64' },
        profile: PROFILES.fast,
      });

      expect(resultFor(text, '✗', 'apple silicon:')).toBeDefined();
    });
  });

  describe('host platform from the environment', () => {
    describe('with the real loader', () => {
      const realLoader =
        (hostEnv: Record<string, string>): DoctorIo['loadConfig'] =>
        (options) =>
          loadConfig({ ...options, envPath: MISSING_ENV, processEnv: hostEnv });

      it('judges the same Mac host the loader resolved the profile for', async () => {
        const h = harness({
          hostEnv: {},
          loadConfig: realLoader({ DIGEST_HOST_OS: 'Darwin', DIGEST_HOST_ARCH: 'arm64' }),
        });

        await onProcess(LINUX, () => doctorCommand({ config: VALID_CONFIG }, h.io));

        expect(resultFor(h.text(), '✓', 'apple silicon:')).toContain('darwin/arm64');
      });

      it('judges the same Linux host the loader fell back for', async () => {
        const h = harness({
          hostEnv: {},
          loadConfig: realLoader({ DIGEST_HOST_OS: 'Linux', DIGEST_HOST_ARCH: 'x86_64' }),
        });

        await onProcess(MAC, () => doctorCommand({ config: VALID_CONFIG }, h.io));

        expect(resultFor(h.text(), '!', 'apple silicon:')).toContain('linux/x64');
      });

      it('prints a readable ✗ naming the variable for a bad value, and checks nothing else', async () => {
        const h = harness({ hostEnv: {}, loadConfig: realLoader({ DIGEST_HOST_OS: 'plan9' }) });

        const code = await doctorCommand({ config: VALID_CONFIG }, h.io);

        expect(code).toBe(1);
        expect(resultFor(h.text(), '✗', 'config:')).toMatch(
          /DIGEST_HOST_OS "plan9".*\n\s+fix: .*variable named above/,
        );
        expect(h.health).not.toHaveBeenCalled();
        expect(h.fetch).not.toHaveBeenCalled();
      });
    });

    it('judges the platform on the loaded config, not one recomputed from the environment', async () => {
      const { text } = await onProcess(MAC, () =>
        runDoctor({
          hostEnv: { DIGEST_HOST_OS: 'darwin', DIGEST_HOST_ARCH: 'arm64' },
          loadedPlatform: LINUX,
          profile: PROFILES.quality,
        }),
      );

      expect(resultFor(text, '✗', 'apple silicon:')).toContain('linux/x64');
    });

    it('leaves the platform to the loader instead of passing one', async () => {
      const h = harness({ hostEnv: { DIGEST_HOST_OS: 'darwin' } });

      await doctorCommand({}, h.io);

      expect(h.loadConfig.mock.calls[0]?.[0].platform).toBeUndefined();
    });
  });

  describe('think', () => {
    it('prints the effective think setting for the roles that can send it', async () => {
      const { text } = await runDoctor();

      expect(resultFor(text, '✓', 'think:')).toBe(
        '✓ think: classify=default, guardRisk=off, write=default',
      );
    });

    it('shows a configured setting over the default', async () => {
      const { text } = await runDoctor({
        config: { models: { think: { write: 'high', guardRisk: true, classify: false } } },
      });

      expect(resultFor(text, '✓', 'think:')).toBe(
        '✓ think: classify=off, guardRisk=on, write=high',
      );
    });

    it('shows what the Ollama adapter sends for each role (effectiveThink), so the two cannot drift', async () => {
      const think = { classify: 'low', guardRisk: true, write: false } as const;
      const { text } = await runDoctor({ config: { models: { think } } });

      const expected = (['classify', 'guardRisk', 'write'] as const).map((role) => {
        const value = effectiveThink(think, role);
        return `${role}=${typeof value === 'boolean' ? (value ? 'on' : 'off') : (value ?? 'default')}`;
      });
      expect(resultFor(text, '✓', 'think:')).toBe(`✓ think: ${expected.join(', ')}`);
    });

    it('warns when a decision-only role is configured, since decide never sends think', async () => {
      const { code, text } = await runDoctor({
        config: { models: { think: { judge: 'low', guardPolicy: false } } },
      });

      expect(resultFor(text, '!', 'think:')).toMatch(
        /ignored for guardPolicy, judge.*\n\s+fix: remove those roles/,
      );
      expect(code).toBe(0);
    });
  });

  describe('models', () => {
    it('prints ✗ with the pull command for each missing model', async () => {
      const { code, text } = await runDoctor({
        health: (profile) => ({
          models: installedFor(profile, ['gemma4:31b-mlx', 'granite4.1-guardian:8b']),
        }),
      });

      expect(code).toBe(1);
      expect(resultFor(text, '✗', 'model gemma4:31b-mlx:')).toMatch(
        /not installed.*\n\s+fix: ollama pull gemma4:31b-mlx$/,
      );
      expect(resultFor(text, '✗', 'model granite4.1-guardian:8b:')).toMatch(
        /\n\s+fix: ollama pull granite4\.1-guardian:8b$/,
      );
      expect(resultFor(text, '✓', 'model clef:latest:')).toBeDefined();
    });

    it('prints ✗ when a decision model is installed without the decision capability', async () => {
      const { code, text } = await runDoctor({
        health: (profile) => ({
          models: installedFor(profile).map((model) =>
            model.name === 'clef:latest' ? { ...model, capabilities: ['completion'] } : model,
          ),
        }),
      });

      expect(code).toBe(1);
      expect(resultFor(text, '✗', 'model clef:latest:')).toMatch(
        /decision.*\n\s+fix: ollama pull clef:latest$/,
      );
    });

    it('does not require the decision capability from writer and Granite models', async () => {
      const { code } = await runDoctor({
        health: (profile) => ({
          models: installedFor(profile).map((model) =>
            model.name === 'clef:latest' ? model : { ...model, capabilities: [] },
          ),
        }),
      });

      expect(code).toBe(0);
    });

    describe('only the models a run would load (modelsInUse)', () => {
      const graniteOff = {
        guards: {
          input: { checks: { graniteRisk: false } },
          output: { checks: { graniteGroundedness: false } },
        },
      } as const;

      it('does not require the Granite model when both of its guards are off', async () => {
        const { code, text } = await runDoctor({
          config: graniteOff,
          health: (profile) => ({ models: installedFor(profile, ['granite4.1-guardian:8b']) }),
        });

        expect(code).toBe(0);
        expect(text).not.toContain('model granite4.1-guardian:8b');
        expect(resultFor(text, '✓', 'model clef:latest:')).toBeDefined();
        expect(resultFor(text, '!', 'guards:')).toContain('graniteRisk');
      });

      it('still requires it when only one of its two guards is off', async () => {
        const { code, text } = await runDoctor({
          config: { guards: { input: { checks: { graniteRisk: false } } } },
          health: (profile) => ({ models: installedFor(profile, ['granite4.1-guardian:8b']) }),
        });

        expect(code).toBe(1);
        expect(resultFor(text, '✗', 'model granite4.1-guardian:8b:')).toBeDefined();
      });

      it('keeps a tag that another role still uses when the guard of one role is off', async () => {
        const { text } = await runDoctor({
          config: {
            profile: 'fast',
            guards: { input: { enabled: false }, output: { checks: { clefRubric: false } } },
          },
          health: (profile) => ({ version: '0.40.0', models: installedFor(profile) }),
        });

        // guardPolicy has no check left, but classify uses the same strands-decider tag.
        expect(resultFor(text, '✓', 'model strands-decider:2b-mlx-bf16:')).toBeDefined();
      });

      it('lists exactly modelsInUse(profile, guards), in that order', async () => {
        const config = {
          guards: { input: { enabled: false }, output: { enabled: false } },
        } as const;
        const { text } = await runDoctor({ config, health: (p) => ({ models: installedFor(p) }) });

        const listed = [...text.matchAll(/^[✓!✗] model (.+?): /gm)].map((match) => match[1]);
        expect(listed).toEqual(modelsInUse(PROFILES.quality, makeConfig(config).guards));
        expect(listed).not.toContain('granite4.1-guardian:8b');
      });
    });

    it('checks the strands-decider decision models of the fast profile', async () => {
      const { code, text } = await runDoctor({
        config: { profile: 'fast' },
        health: (profile) => ({
          version: '0.40.0',
          models: installedFor(profile).map((model) =>
            model.name === 'strands-decider:2b-mlx-bf16' ? { ...model, capabilities: [] } : model,
          ),
        }),
      });

      expect(code).toBe(1);
      expect(resultFor(text, '✗', 'model strands-decider:2b-mlx-bf16:')).toBeDefined();
    });

    it('does not mistake a registry port for a version tag', async () => {
      const tag = 'localhost:5000/team/writer';
      const { code, text } = await runDoctor({
        config: { models: { writers: [tag] } },
        health: (profile) => ({
          models: [...installedFor(profile), { name: `${tag}:latest`, capabilities: [] }],
        }),
      });

      expect(code).toBe(0);
      expect(resultFor(text, '✓', `model ${tag}:`)).toBeDefined();
    });

    it('treats a tag without a version as :latest', async () => {
      const { code, text } = await runDoctor({
        config: { models: { writers: ['my-writer'] } },
        health: (profile) => ({
          models: [...installedFor(profile), { name: 'my-writer:latest', capabilities: [] }],
        }),
      });

      expect(code).toBe(0);
      expect(resultFor(text, '✓', 'model my-writer:')).toBeDefined();
    });

    it('checks the configured writer override instead of the profile writers', async () => {
      const { text } = await runDoctor({
        config: { models: { writers: ['gemma4:31b'] } },
        health: (profile) => ({ models: installedFor(profile) }),
      });

      expect(resultFor(text, '✓', 'model gemma4:31b:')).toBeDefined();
      expect(text).not.toContain('gemma4:31b-mlx');
    });
  });

  describe('sources', () => {
    it('reads every source through the real fetchers with a one-day window', async () => {
      const { h } = await runDoctor({
        config: {
          sources: [
            { id: 'example-feed', kind: 'rss', url: FEED_URL },
            { id: 'acme-tool', kind: 'github', url: GITHUB_URL },
          ],
        },
      });

      const urls = h.fetch.mock.calls.map(([input]) => String(input));
      expect(urls).toEqual([FEED_URL, `${GITHUB_URL}/releases.atom`]);
    });

    it('prints ! naming the source for an HTTP failure and still returns 0', async () => {
      const { code, text } = await runDoctor({
        fetch: async () => new Response('gone', { status: 404 }),
      });

      expect(code).toBe(0);
      expect(resultFor(text, '!', 'source example-feed:')).toMatch(
        /404.*\n\s+fix: .*(feed|source).*digest\.config\.json/i,
      );
    });

    it('prints ! for a feed that cannot be parsed', async () => {
      const { code, text } = await runDoctor({
        fetch: async () => new Response('<html>not a feed</html>', { status: 200 }),
      });

      expect(code).toBe(0);
      expect(resultFor(text, '!', 'source example-feed:')).toBeDefined();
    });

    it('prints ! when a source does not answer within the timeout', async () => {
      const { code, text } = await runDoctor({
        sourceTimeoutMs: 20,
        fetch: () => new Promise<Response>(() => undefined),
      });

      expect(code).toBe(0);
      expect(resultFor(text, '!', 'source example-feed:')).toMatch(/timed out/i);
    });

    it('reports each source on its own and keeps config order', async () => {
      const { text } = await runDoctor({
        config: {
          sources: [
            { id: 'first', kind: 'rss', url: 'https://one.example.com/feed.xml' },
            { id: 'second', kind: 'rss', url: 'https://two.example.com/feed.xml' },
            { id: 'third', kind: 'rss', url: 'https://three.example.com/feed.xml' },
          ],
        },
        fetch: async (input) =>
          urlOf(input).startsWith('https://two.')
            ? new Response('no', { status: 500 })
            : new Response(ATOM_FEED, { status: 200 }),
      });

      expect(resultFor(text, '✓', 'source first:')).toBeDefined();
      expect(resultFor(text, '!', 'source second:')).toBeDefined();
      expect(resultFor(text, '✓', 'source third:')).toBeDefined();
      expect(text.indexOf('source first')).toBeLessThan(text.indexOf('source second'));
      expect(text.indexOf('source second')).toBeLessThan(text.indexOf('source third'));
    });

    it('never prints the source URL, its query or credentials embedded in another URL', async () => {
      const privateUrl = 'https://feeds.example.com/f.xml?token=abc123';
      const { text } = await runDoctor({
        config: { sources: [{ id: 'priv', kind: 'rss', url: privateUrl }] },
        fetch: async () => new Response('no', { status: 401 }),
        health: { error: `Ollama at http://u:pw@localhost:11434 failed`, models: [] },
      });

      expect(text).not.toMatch(/abc123|feeds\.example\.com|u:pw@/);
      expect(resultFor(text, '!', 'source priv:')).toContain('401');
      expect(text).toContain('http://localhost:11434 failed');
    });

    describe('a source URL with credentials in it', () => {
      const CREDENTIAL_URL = 'https://user:s3cret@feeds.example.com/f.xml?token=abc123';
      let dir: string;

      beforeEach(async () => {
        dir = await mkdtemp(join(tmpdir(), 'digest-doctor-creds-'));
      });

      afterEach(async () => {
        await rm(dir, { recursive: true, force: true });
      });

      async function doctorOnConfigWith(url: string): Promise<{ code: number; text: string }> {
        const configPath = join(dir, 'digest.config.json');
        await writeFile(
          configPath,
          JSON.stringify({
            focusAreas: ['AI models and tooling'],
            sources: [{ id: 'priv', kind: 'rss', url }],
            schedule: { timeZone: 'Europe/Berlin' },
          }),
        );
        const h = harness({
          loadConfig: (options) => loadConfig({ ...options, envPath: MISSING_ENV, processEnv: {} }),
        });
        const code = await doctorCommand({ config: configPath }, h.io);
        expect(h.fetch).not.toHaveBeenCalled();
        return { code, text: h.text() };
      }

      it('fails the config check and names the field, never the URL or the secret', async () => {
        const { code, text } = await doctorOnConfigWith(CREDENTIAL_URL);

        expect(code).toBe(1);
        expect(resultFor(text, '✗', 'config:')).toContain('Invalid config');
        expect(text).toContain('at sources[0].url');
        expect(text).toMatch(/username or password/);
        expect(text).not.toMatch(/s3cret|abc123|feeds\.example\.com|user:/);
      });

      it('runs no other check, since the config is not usable', async () => {
        const { text } = await doctorOnConfigWith(CREDENTIAL_URL);

        expect(text).not.toContain('source priv');
        expect(text).not.toContain('ollama');
      });
    });

    it('never prints a secret that appears in a source error', async () => {
      const { text } = await runDoctor({
        secrets: { GITHUB_TOKEN: 'ghp_supersecrettoken' },
        fetch: async () => {
          throw new Error('request failed with token ghp_supersecrettoken');
        },
      });

      expect(text).not.toContain('ghp_supersecrettoken');
      expect(resultFor(text, '!', 'source example-feed:')).toContain('[redacted]');
    });
  });

  describe('delivery', () => {
    const email = {
      host: 'smtp.example.com',
      user: 'digest',
      from: 'digest@example.com',
      to: ['me@example.com'],
    };

    it('prints ✗ when email is configured without SMTP_PASSWORD', async () => {
      const { code, text } = await runDoctor({ config: { delivery: { email } } });

      expect(code).toBe(1);
      expect(resultFor(text, '✗', 'email:')).toMatch(
        /SMTP_PASSWORD.*\n\s+fix: .*SMTP_PASSWORD.*\.env/,
      );
    });

    it('prints ✓ when email is configured and SMTP_PASSWORD is present', async () => {
      const { code, text } = await runDoctor({
        config: { delivery: { email } },
        secrets: { SMTP_PASSWORD: 'hunter2-password' },
      });

      expect(code).toBe(0);
      expect(resultFor(text, '✓', 'email:')).toBeDefined();
      expect(text).not.toContain('hunter2-password');
    });

    it('prints ✗ when Slack is enabled without SLACK_WEBHOOK_URL', async () => {
      const { code, text } = await runDoctor({
        config: { delivery: { slack: { enabled: true } } },
      });

      expect(code).toBe(1);
      expect(resultFor(text, '✗', 'slack:')).toMatch(/SLACK_WEBHOOK_URL.*\n\s+fix: .*\.env/);
    });

    it('prints ✓ when Slack is enabled and the webhook is present, without printing it', async () => {
      const webhook = 'https://hooks.slack.com/services/T000/B000/secretvalue';
      const { code, text } = await runDoctor({
        config: { delivery: { slack: { enabled: true } } },
        secrets: { SLACK_WEBHOOK_URL: webhook },
      });

      expect(code).toBe(0);
      expect(resultFor(text, '✓', 'slack:')).toBeDefined();
      expect(text).not.toContain('secretvalue');
    });

    it('does not check Slack when it is disabled', async () => {
      const { text } = await runDoctor({ config: { delivery: { slack: { enabled: false } } } });

      expect(text).not.toContain('slack:');
    });

    it('never sends anything: only the source feeds are contacted', async () => {
      const { h } = await runDoctor({
        config: { delivery: { email, slack: { enabled: true } } },
        secrets: {
          SMTP_PASSWORD: 'hunter2-password',
          SLACK_WEBHOOK_URL: 'https://hooks.slack.com/services/T000/B000/secretvalue',
        },
      });

      expect(h.fetch.mock.calls.map(([input]) => String(input))).toEqual([FEED_URL]);
    });
  });

  describe('.env permissions', () => {
    it.each([0o644, 0o640, 0o604, 0o666])(
      'prints ! with chmod 600 when .env has mode %o',
      async (mode) => {
        const { code, text } = await runDoctor({ envMode: mode });

        expect(code).toBe(0);
        expect(resultFor(text, '!', '.env:')).toMatch(
          /readable by other users.*\n\s+fix: chmod 600 \.env$/,
        );
      },
    );

    it.each([0o600, 0o400, 0o700])('prints ✓ when .env has mode %o', async (mode) => {
      const { text } = await runDoctor({ envMode: mode });

      expect(resultFor(text, '✓', '.env:')).toBeDefined();
    });

    it('prints ✓ when there is no .env file', async () => {
      const { code, text } = await runDoctor({ envMode: null });

      expect(code).toBe(0);
      expect(resultFor(text, '✓', '.env:')).toMatch(/no \.env file/i);
    });

    it('prints ! when .env cannot be inspected', async () => {
      const { code, text } = await runDoctor({ envStatError: errnoError('EACCES') });

      expect(code).toBe(0);
      expect(resultFor(text, '!', '.env:')).toContain('EACCES');
    });
  });

  describe('.env values cut at a "#"', () => {
    it('prints ✓ when no unquoted value holds a "#"', async () => {
      const envText = [
        '# written by digest init',
        'OLLAMA_URL=http://localhost:11434',
        'SMTP_PASSWORD="has # inside quotes"',
        "GITHUB_TOKEN='and # here'",
        'LOG_LEVEL=info',
        '',
      ].join('\n');

      const { text } = await runDoctor({ envText });

      expect(resultFor(text, '✓', '.env values:')).toBeDefined();
    });

    it('warns for a value with " #", naming the key and the line but never the value', async () => {
      const envText =
        'OLLAMA_URL=http://localhost:11434\nSMTP_PASSWORD=correct horse #battery staple\n';

      const { code, text } = await runDoctor({ envText });

      expect(code).toBe(0);
      expect(resultFor(text, '!', '.env values:')).toMatch(
        /SMTP_PASSWORD \(line 2\).*read as a comment.*\n\s+fix: put the value in quotes/,
      );
      expect(text).not.toMatch(/battery|correct horse/);
    });

    it('warns for a "#" without a space too, where the loader cuts the value as well', async () => {
      const { text } = await runDoctor({ envText: 'GITHUB_TOKEN=ghp_abc#def\n' });

      expect(resultFor(text, '!', '.env values:')).toContain('GITHUB_TOKEN (line 1)');
      expect(text).not.toContain('ghp_abc');
    });

    it('names every affected key once, in file order', async () => {
      const envText = ['A=one #two', 'B=fine', 'export C=three#four', 'A=again #cut', ''].join(
        '\n',
      );

      const { text } = await runDoctor({ envText });

      const line = resultFor(text, '!', '.env values:')!;
      expect(line).toContain('A (line 1)');
      expect(line).toContain('C (line 3)');
      expect(line).not.toMatch(/\bB \(line/);
      expect(line.match(/A \(line/g)).toHaveLength(1);
    });

    it('does not mistake a comment line, an empty value or a quoted value for a cut one', async () => {
      const envText = [
        '#SMTP_PASSWORD=x #y',
        '   # indented comment with KEY=a #b',
        'EMPTY=',
        'Q1="a #b"',
        "Q2='a #b'",
        'Q3=`a #b`',
        '',
      ].join('\n');

      const { text } = await runDoctor({ envText });

      expect(resultFor(text, '✓', '.env values:')).toBeDefined();
    });

    it('ignores the lines of a quoted value that spans several lines', async () => {
      const envText = 'KEY="first line\nsecond # line\nthird"\nNEXT=ok\n';

      const { text } = await runDoctor({ envText });

      expect(resultFor(text, '✓', '.env values:')).toBeDefined();
    });

    it('still reads the lines after a quote that nothing closes, as the parser does', async () => {
      const envText = 'BROKEN="never closed\nSMTP_PASSWORD=pa#ss\nOTHER=fine\n';

      const { text } = await runDoctor({ envText });

      const line = resultFor(text, '!', '.env values:')!;
      expect(line).toContain('SMTP_PASSWORD (line 2)');
      expect(line).not.toContain('BROKEN');
      expect(text).not.toContain('pa#ss');
    });

    it('follows a quote across lines to the next one of the same kind, even a stray one', async () => {
      const envText =
        'A="opens here\nB=1 #hidden in the value of A\nC=\'x\'\nD="closes A"\nE=v#w\n';

      const { text } = await runDoctor({ envText });

      const line = resultFor(text, '!', '.env values:')!;
      expect(line).toContain('E (line 5)');
      expect(line).not.toMatch(/\bB \(line/);
    });

    it('is quiet when there is no .env file', async () => {
      const { text } = await runDoctor({ envMode: null });

      expect(text).not.toContain('.env values');
    });

    it('warns when .env cannot be read, and says why', async () => {
      const { code, text } = await runDoctor({ envReadError: errnoError('EACCES') });

      expect(code).toBe(0);
      expect(resultFor(text, '!', '.env values:')).toContain('EACCES');
    });

    it('does not count toward the errors', async () => {
      const { code, text } = await runDoctor({ envText: 'A=b #c\n' });

      expect(code).toBe(0);
      expect(text).toMatch(/0 errors, 1 warning\b/);
    });
  });

  describe('guards', () => {
    it('prints ! naming every check of a disabled input section', async () => {
      const { code, text } = await runDoctor({ config: { guards: { input: { enabled: false } } } });

      expect(code).toBe(0);
      const line = resultFor(text, '!', 'guards:');
      expect(line).toContain('clefPolicy');
      expect(line).toContain('graniteRisk');
      expect(line).toMatch(/\n\s+fix: .*digest\.config\.json/);
    });

    it('prints ! naming only the single check that is off', async () => {
      const { text } = await runDoctor({
        config: { guards: { output: { checks: { clefRubric: false } } } },
      });

      const line = resultFor(text, '!', 'guards:');
      expect(line).toContain('clefRubric');
      expect(line).not.toContain('graniteGroundedness');
    });

    it('names input and output checks together', async () => {
      const { text } = await runDoctor({
        config: {
          guards: {
            input: { checks: { graniteRisk: false } },
            output: { enabled: false },
          },
        },
      });

      const line = resultFor(text, '!', 'guards:');
      for (const check of ['graniteRisk', 'graniteGroundedness', 'clefRubric']) {
        expect(line).toContain(check);
      }
      expect(line).not.toContain('clefPolicy');
    });

    it('prints ✓ when every guard is on', async () => {
      const { text } = await runDoctor();

      expect(resultFor(text, '✓', 'guards:')).toMatch(/all .*on/i);
    });
  });

  describe('data directory', () => {
    it('prints ✗ with a fix when dataDir exists but is not writable', async () => {
      const { code, text } = await runDoctor({ readOnlyDirs: [DATA_DIR] });

      expect(code).toBe(1);
      expect(resultFor(text, '✗', 'data dir:')).toMatch(new RegExp(`${DATA_DIR}.*\\n\\s+fix: `));
    });

    it('prints ✓ when dataDir does not exist yet but its parent is writable', async () => {
      const { code, text } = await runDoctor({ existingDirs: ['/', '/srv', '/srv/digest'] });

      expect(code).toBe(0);
      expect(resultFor(text, '✓', 'data dir:')).toMatch(/created|does not exist yet/i);
    });

    it('prints ✗ when dataDir does not exist and the nearest existing parent is read-only', async () => {
      const { code, text } = await runDoctor({
        existingDirs: ['/', '/srv', '/srv/digest'],
        readOnlyDirs: ['/srv/digest'],
      });

      expect(code).toBe(1);
      expect(resultFor(text, '✗', 'data dir:')).toContain('/srv/digest');
    });

    it('prints ✗ when no parent exists at all', async () => {
      const { code, text } = await runDoctor({ existingDirs: [] });

      expect(code).toBe(1);
      expect(resultFor(text, '✗', 'data dir:')).toBeDefined();
    });

    it('prints ✗ when dataDir is a file, even a writable one', async () => {
      const { code, text } = await runDoctor({ fs: { [DATA_DIR]: { kind: 'file' } } });

      expect(code).toBe(1);
      expect(resultFor(text, '✗', 'data dir:')).toMatch(
        new RegExp(`${DATA_DIR} is a file, not a folder.*\\n\\s+fix: .*"dataDir"`),
      );
    });

    it('prints ✗ when dataDir is a dangling symbolic link, which a run cannot create', async () => {
      const { code, text } = await runDoctor({
        fs: { [DATA_DIR]: { kind: 'symlink', target: '/mnt/gone/data' } },
      });

      expect(code).toBe(1);
      expect(resultFor(text, '✗', 'data dir:')).toMatch(
        new RegExp(`${DATA_DIR} is a symbolic link to a path that does not exist`),
      );
    });

    it('prints ✗ when dataDir is a symbolic link to a file', async () => {
      const { code, text } = await runDoctor({
        fs: { [DATA_DIR]: { kind: 'symlink', target: '/srv/file' }, '/srv/file': { kind: 'file' } },
      });

      expect(code).toBe(1);
      expect(resultFor(text, '✗', 'data dir:')).toContain('is a file, not a folder');
    });

    it('prints ✓ when dataDir is a symbolic link to a writable folder', async () => {
      const { code, text } = await runDoctor({
        fs: {
          [DATA_DIR]: { kind: 'symlink', target: '/mnt/data' },
          '/mnt/data': { kind: 'dir' },
        },
      });

      expect(code).toBe(0);
      expect(resultFor(text, '✓', 'data dir:')).toContain(`${DATA_DIR} is writable`);
    });

    it('prints ✗ when a symbolic link to a folder is not writable', async () => {
      const { text } = await runDoctor({
        fs: {
          [DATA_DIR]: { kind: 'symlink', target: '/mnt/data' },
          '/mnt/data': { kind: 'dir', writable: false },
        },
      });

      expect(resultFor(text, '✗', 'data dir:')).toContain('cannot write');
    });

    it('prints ✗ when the nearest existing parent is a file, so dataDir cannot be created', async () => {
      const { code, text } = await runDoctor({
        config: { dataDir: '/srv/blocked/data' },
        fs: { '/srv/blocked': { kind: 'file' } },
      });

      expect(code).toBe(1);
      expect(resultFor(text, '✗', 'data dir:')).toMatch(
        /\/srv\/blocked is a file, so \/srv\/blocked\/data cannot be created below it/,
      );
    });

    it('prints ✗ when a parent is a dangling symbolic link', async () => {
      const { text } = await runDoctor({
        config: { dataDir: '/srv/link/data' },
        fs: { '/srv/link': { kind: 'symlink', target: '/nowhere' } },
      });

      expect(resultFor(text, '✗', 'data dir:')).toContain('/srv/link is a symbolic link');
    });

    it('names the file when lstat answers ENOTDIR for the path below it', async () => {
      const h = harness({ config: { dataDir: '/srv/file/data/deeper' } });
      h.io.lstat = async (path) => {
        if (path === '/srv/file')
          return { mode: 0o100644, isDirectory: false, isSymbolicLink: false };
        throw errnoError(path.startsWith('/srv/file/') ? 'ENOTDIR' : 'ENOENT');
      };

      const code = await doctorCommand({}, h.io);

      expect(code).toBe(1);
      expect(resultFor(h.text(), '✗', 'data dir:')).toMatch(
        /\/srv\/file is a file, so \/srv\/file\/data\/deeper cannot be created below it.*\n\s+fix: remove or replace \/srv\/file,/,
      );
    });

    it('prints ✗ with the reason when the path cannot be inspected', async () => {
      const h = harness();
      h.io.lstat = async () => {
        throw errnoError('EIO');
      };

      const code = await doctorCommand({}, h.io);

      expect(code).toBe(1);
      expect(resultFor(h.text(), '✗', 'data dir:')).toMatch(/cannot inspect.*EIO/);
    });

    it('resolves a relative dataDir against the working directory', async () => {
      const h = harness({ config: { dataDir: 'rel/data' } });
      const seen: string[] = [];
      const lstat = h.io.lstat!;
      h.io.lstat = async (path) => {
        seen.push(path);
        return lstat(path);
      };

      await doctorCommand({}, h.io);

      expect(seen).toContain(join(process.cwd(), 'rel/data'));
    });
  });

  describe('markdown directory', () => {
    const MARKDOWN_DIR = '/srv/digest/data/digests';
    const withDir = { delivery: { markdown: { dir: MARKDOWN_DIR } } } as const;

    it('prints ✓ naming the folder when it exists and is writable', async () => {
      const { code, text } = await runDoctor({
        config: withDir,
        fs: { [MARKDOWN_DIR]: { kind: 'dir' } },
      });

      expect(code).toBe(0);
      expect(resultFor(text, '✓', 'markdown:')).toContain(`digests are written to ${MARKDOWN_DIR}`);
    });

    it('prints ✓ when it does not exist yet but a parent is writable', async () => {
      const { code, text } = await runDoctor({ config: withDir });

      expect(code).toBe(0);
      expect(resultFor(text, '✓', 'markdown:')).toMatch(
        /does not exist yet; \/srv\/digest\/data is writable, so a run creates it/,
      );
    });

    it('prints ✗ with a fix naming the setting when the folder is read-only', async () => {
      const { code, text } = await runDoctor({
        config: withDir,
        fs: { [MARKDOWN_DIR]: { kind: 'dir', writable: false } },
      });

      expect(code).toBe(1);
      expect(resultFor(text, '✗', 'markdown:')).toMatch(
        new RegExp(`cannot write to ${MARKDOWN_DIR}.*\\n\\s+fix: .*"delivery.markdown.dir"`),
      );
    });

    it('prints ✗ when the folder does not exist and its nearest parent is read-only', async () => {
      const { code, text } = await runDoctor({
        config: withDir,
        fs: { [DATA_DIR]: { kind: 'dir', writable: false } },
      });

      expect(code).toBe(1);
      expect(resultFor(text, '✗', 'markdown:')).toContain(DATA_DIR);
    });

    it('prints ✗ when it is a file', async () => {
      const { code, text } = await runDoctor({
        config: withDir,
        fs: { [MARKDOWN_DIR]: { kind: 'file' } },
      });

      expect(code).toBe(1);
      expect(resultFor(text, '✗', 'markdown:')).toContain(
        `${MARKDOWN_DIR} is a file, not a folder`,
      );
    });

    it('prints ✗ when it is a dangling symbolic link', async () => {
      const { text } = await runDoctor({
        config: withDir,
        fs: { [MARKDOWN_DIR]: { kind: 'symlink', target: '/mnt/gone' } },
      });

      expect(resultFor(text, '✗', 'markdown:')).toContain(
        'symbolic link to a path that does not exist',
      );
    });

    it('resolves the default relative folder against the working directory', async () => {
      const h = harness();
      const seen: string[] = [];
      const lstat = h.io.lstat!;
      h.io.lstat = async (path) => {
        seen.push(path);
        return lstat(path);
      };

      await doctorCommand({}, h.io);

      expect(seen).toContain(join(process.cwd(), 'dist/digests'));
    });
  });

  describe('exit code and summary', () => {
    it('returns 0 and counts warnings when there are only warnings', async () => {
      const { code, text } = await runDoctor({
        envMode: 0o644,
        config: { guards: { input: { enabled: false } } },
      });

      expect(code).toBe(0);
      expect(text).toMatch(/0 errors, 2 warnings/);
    });

    it('returns 1 and counts errors when any check fails', async () => {
      const { code, text } = await runDoctor({
        readOnlyDirs: [DATA_DIR],
        envMode: 0o644,
      });

      expect(code).toBe(1);
      expect(text).toMatch(/1 error, 1 warning\b/);
    });
  });

  describe('with the real file system', () => {
    let dir: string;

    beforeEach(async () => {
      dir = await mkdtemp(join(tmpdir(), 'digest-doctor-'));
    });

    afterEach(async () => {
      await rm(dir, { recursive: true, force: true });
    });

    const DISK_FUNCTIONS: ReadonlySet<string> = new Set(['stat', 'lstat', 'readFile', 'access']);

    /** Doctor with the real stat, lstat, readFile and access, and fakes for everything else. */
    async function doctorOnDisk(setup: Setup): Promise<{ code: number; text: string }> {
      const h = harness({ ...setup, envMode: null });
      const fakes = Object.entries(h.io).filter(([name]) => !DISK_FUNCTIONS.has(name));
      const io: Partial<DoctorIo> = { ...Object.fromEntries(fakes), envPath: join(dir, '.env') };
      const code = await doctorCommand({}, io);
      return { code, text: h.text() };
    }

    it('passes for a folder that exists and a missing one below it', async () => {
      await mkdir(join(dir, 'data'));

      const { code, text } = await doctorOnDisk({
        config: {
          dataDir: join(dir, 'data'),
          delivery: { markdown: { dir: join(dir, 'data', 'digests') } },
        },
      });

      expect(resultFor(text, '✓', 'data dir:')).toContain('is writable');
      expect(resultFor(text, '✓', 'markdown:')).toContain('does not exist yet');
      expect(code).toBe(0);
    });

    it('fails a dataDir that is a file', async () => {
      await writeFile(join(dir, 'data'), 'x');

      const { code, text } = await doctorOnDisk({ config: { dataDir: join(dir, 'data') } });

      expect(code).toBe(1);
      expect(resultFor(text, '✗', 'data dir:')).toContain('is a file, not a folder');
    });

    it('fails a dataDir that is a dangling symbolic link', async () => {
      await symlink(join(dir, 'gone'), join(dir, 'data'));

      const { code, text } = await doctorOnDisk({ config: { dataDir: join(dir, 'data') } });

      expect(code).toBe(1);
      expect(resultFor(text, '✗', 'data dir:')).toContain(
        'symbolic link to a path that does not exist',
      );
    });

    it('follows a symbolic link to a folder', async () => {
      await mkdir(join(dir, 'real'));
      await symlink(join(dir, 'real'), join(dir, 'data'));

      const { text } = await doctorOnDisk({ config: { dataDir: join(dir, 'data') } });

      expect(resultFor(text, '✓', 'data dir:')).toContain('is writable');
    });

    it('fails when a file sits on the way to the folder', async () => {
      await writeFile(join(dir, 'blocker'), 'x');

      const { text } = await doctorOnDisk({
        config: { dataDir: join(dir, 'blocker', 'data') },
      });

      expect(resultFor(text, '✗', 'data dir:')).toMatch(
        /is a file, so .* cannot be created below it/,
      );
    });

    it('warns about a value cut at "#" in the real .env, without printing it', async () => {
      await writeFile(join(dir, '.env'), 'GITHUB_TOKEN=ghp_secret#tail\n', { mode: 0o600 });
      await mkdir(join(dir, 'data'));

      const { text } = await doctorOnDisk({ config: { dataDir: join(dir, 'data') } });

      expect(resultFor(text, '!', '.env values:')).toContain('GITHUB_TOKEN (line 1)');
      expect(resultFor(text, '✓', '.env:')).toContain('readable only by you');
      expect(text).not.toContain('ghp_secret');
    });

    it('says nothing about a missing .env beyond the .env check', async () => {
      const { text } = await doctorOnDisk({ config: { dataDir: dir } });

      expect(resultFor(text, '✓', '.env:')).toMatch(/no \.env file/i);
      expect(text).not.toContain('.env values');
    });
  });
});
