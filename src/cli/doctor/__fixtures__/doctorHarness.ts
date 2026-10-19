// Test kit for the doctor folders: a fake machine (config, Ollama, disk, feeds) that `doctorCommand`
// and the check modules run against. Not product code; coverage skips `__fixtures__/`.
import { vi, type Mock } from 'vitest';
import { join } from 'node:path';
import type { LoadedConfig } from '../../../config/load';
import {
  requiredModels,
  resolveProfile,
  type ModelProfile,
  type Platform,
} from '../../../config/profiles';
import type { ConfigInput, Secrets } from '../../../config/schema';
import type { ModelHealth } from '../../../models/ModelProvider';
import { makeConfig } from '../../../../test/builders';
import { FakeModelProvider, fixedClock } from '../../../../test/fakes';
import { doctorCommand } from '../doctor';
import type { DoctorIo } from '../types';

export const MAC: Platform = { os: 'darwin', arch: 'arm64' };
export const LINUX: Platform = { os: 'linux', arch: 'x64' };
const CONFIG_FIXTURES = join(
  import.meta.dirname,
  '..',
  '..',
  '..',
  '..',
  'test',
  'fixtures',
  'config',
);
export const VALID_CONFIG = join(CONFIG_FIXTURES, 'valid.config.json');
export const MISSING_ENV = join(CONFIG_FIXTURES, 'missing.env');
export const DATA_DIR = '/srv/digest/data';
export const ENV_PATH = '/srv/digest/.env';
export const FEED_URL = 'https://example.com/feed.xml';
export const GITHUB_URL = 'https://github.com/acme/tool';
export const ATOM_FEED =
  '<?xml version="1.0"?><feed xmlns="http://www.w3.org/2005/Atom"><title>t</title><id>t</id>' +
  '<updated>2026-10-15T00:00:00Z</updated><entry><title>v1</title><id>a</id>' +
  '<link href="https://github.com/acme/tool/releases/tag/v1"/><updated>2026-10-15T00:00:00Z</updated></entry></feed>';

/** Tags that must be decision models for a profile: classify, guardPolicy and the judge. */
function decisionTags(profile: ModelProfile): string[] {
  return [profile.classify, profile.guardPolicy, ...(profile.judge ? [profile.judge] : [])];
}

/** Every model a profile needs, as Ollama lists them; `skip` leaves some out. */
export function installedFor(
  profile: ModelProfile,
  skip: readonly string[] = [],
): ModelHealth['models'] {
  const decision = new Set(decisionTags(profile));
  return requiredModels(profile)
    .filter((tag) => !skip.includes(tag))
    .map((name) => ({ name, capabilities: decision.has(name) ? ['decision'] : ['completion'] }));
}

export function urlOf(input: string | URL | Request): string {
  if (typeof input === 'string') return input;
  return input instanceof URL ? input.href : input.url;
}

export function errnoError(code: string): Error {
  return Object.assign(new Error(`${code}: simulated`), { code });
}

/** What is on the fake disk at a path. */
export type FsEntry =
  | { kind: 'dir'; writable?: boolean }
  | { kind: 'file'; mode?: number; writable?: boolean; content?: string }
  | { kind: 'symlink'; target: string };

export interface Setup {
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

export interface Harness {
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

/** The config the loader would return for this setup. */
export function loadedFor(setup: Setup = {}): LoadedConfig {
  const platform = setup.platform ?? MAC;
  const config = makeConfig({ dataDir: DATA_DIR, ...setup.config });
  const profile = setup.profile ?? resolveProfile(config.profile, platform, config.models.writers);
  return {
    config,
    env: { OLLAMA_URL: 'http://localhost:11434', LOG_LEVEL: 'info', ...setup.hostEnv },
    secrets: setup.secrets ?? {},
    profile,
    configPath: '/srv/digest/digest.config.json',
    platform: setup.loadedPlatform ?? platform,
  };
}

export function harness(setup: Setup = {}): Harness {
  const platform = setup.platform ?? MAC;
  const loaded = loadedFor(setup);
  const { profile } = loaded;
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

/** The three disk calls the folder checks use, over the fake disk of `setup`. */
export function diskIo(setup: Setup = {}): Pick<DoctorIo, 'stat' | 'lstat' | 'access'> {
  const { stat, lstat, access } = harness(setup).io as DoctorIo;
  return { stat, lstat, access };
}

/** The result line that starts with `symbol` and mentions `fragment`, plus its fix line. */
export function resultFor(
  text: string,
  symbol: '✓' | '!' | '✗',
  fragment: string,
): string | undefined {
  const lines = text.split('\n');
  const index = lines.findIndex((line) => line.startsWith(`${symbol} `) && line.includes(fragment));
  if (index < 0) return undefined;
  const next = lines[index + 1] ?? '';
  return next.trimStart().startsWith('fix:') ? `${lines[index]}\n${next}` : lines[index];
}

/** Runs `run` while `process` claims to be `platform`; the real values come back afterwards. */
export async function onProcess<T>(platform: Platform, run: () => Promise<T>): Promise<T> {
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

export async function runDoctor(
  setup: Setup = {},
): Promise<{ code: number; text: string; h: Harness }> {
  const h = harness(setup);
  const code = await doctorCommand({}, h.io);
  return { code, text: h.text(), h };
}
