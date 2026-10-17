import { statfs } from 'node:fs/promises';
import { homedir, totalmem } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { createOllamaProvider } from '../adapters/models/ollama.js';
import {
  loadConfig,
  platformOf,
  resolveHostPlatform,
  type LoadedConfig,
  type LoadOptions,
} from '../config/load.js';
import {
  isAppleSilicon,
  NON_MAC_FALLBACK,
  PROFILES,
  requiredModels,
  type ModelProfile,
  type Platform,
} from '../config/profiles.js';
import { ConfigSchema, EnvSchema, ProfileNameSchema } from '../config/schema.js';
import type { ModelHealth } from '../ports/ModelProvider.js';
import { errorMessage } from '../shared/errors.js';
import { withTimeout } from '../shared/retry.js';
import { noopLogger } from '../shared/telemetry.js';

// ---------------------------------------------------------------------------------------------
// Figures shared with `digest init` and `digest doctor`

export const GIB = 1024 ** 3;
const QUALITY_MIN_RAM_GIB = 32;
const LIGHT_MIN_RAM_GIB = 16;
/** Nothing in any profile runs below this: `light` is the smallest set. Used where RAM is not measured. */
const RAM_FLOOR_GIB = LIGHT_MIN_RAM_GIB;
/** A "32 GB" machine reports less (a Linux box about 31 GiB): the kernel keeps some for itself. */
const RAM_TOLERANCE = 0.05;

/** Whether `totalMemoryBytes` covers `requiredGiB`, less a 5% tolerance. */
export function hasRam(totalMemoryBytes: number, requiredGiB: number): boolean {
  return totalMemoryBytes >= requiredGiB * GIB * (1 - RAM_TOLERANCE);
}

/** Whether `quality` fits in this much RAM: 32 GiB, less a 5% tolerance. */
export function hasQualityMemory(totalMemoryBytes: number): boolean {
  return hasRam(totalMemoryBytes, QUALITY_MIN_RAM_GIB);
}

export function formatGiB(bytes: number): string {
  return `${(bytes / GIB).toFixed(1)} GiB`;
}

export type RowName = 'quality' | 'fast' | 'light' | 'fallback';
/** `maybe`: at least the 16 GiB floor, but the profile's real need is not measured. */
export type RamFit = 'yes' | 'no' | 'maybe';

const MEASURED_RAM_GIB: Readonly<Partial<Record<RowName, number>>> = {
  quality: QUALITY_MIN_RAM_GIB,
  light: LIGHT_MIN_RAM_GIB,
};

export function fitsRam(name: RowName, totalMemoryBytes: number): RamFit {
  const measured = MEASURED_RAM_GIB[name];
  if (measured !== undefined) return hasRam(totalMemoryBytes, measured) ? 'yes' : 'no';
  return hasRam(totalMemoryBytes, RAM_FLOOR_GIB) ? 'maybe' : 'no';
}

// ---------------------------------------------------------------------------------------------
// Versions and tags

const URL_CREDENTIALS = /(\bhttps?:\/\/)[^\s/@]+@/g;

/** `https://user:pass@host` becomes `https://host`: credentials in a URL must not reach pasted output. */
export function withoutUrlCredentials(text: string): string {
  return text.replace(URL_CREDENTIALS, '$1');
}

const VERSION_PATTERN = /^v?(\d+)\.(\d+)\.(\d+)(.*)$/;
/** Ollama builds from source (and some test builds) report this. */
export const DEVELOPMENT_VERSION = [0, 0, 0] as const;

export type Core = readonly [number, number, number];
export interface Version {
  core: Core;
  /** "-rc1", "-dev": semver puts it below the release of the same number. */
  prerelease: boolean;
}

export function parseVersion(text: string): Version | undefined {
  const match = VERSION_PATTERN.exec(text.trim());
  if (!match) return undefined;
  const [, major = '0', minor = '0', patch = '0', rest = ''] = match;
  return {
    core: [Number(major), Number(minor), Number(patch)],
    prerelease: rest.startsWith('-') || /^[a-z]/i.test(rest),
  };
}

export function compareCore(a: Core, b: Core): number {
  const index = a.findIndex((part, i) => part !== b[i]);
  return index < 0 ? 0 : (a[index] ?? 0) - (b[index] ?? 0);
}

/** Ollama lists an untagged name as ":latest". */
export function normalizeTag(tag: string): string {
  const name = tag.slice(tag.lastIndexOf('/') + 1); // a registry port ("host:5000/x") is not a version
  return name.includes(':') ? tag : `${tag}:latest`;
}

// ---------------------------------------------------------------------------------------------
// The command

export interface ReadinessCommandOptions {
  /** Path to digest.config.json; optional, readiness works without one. */
  config?: string;
}

/** Everything readiness touches outside itself; tests replace it. */
export interface ReadinessIo {
  loadConfig: (options: LoadOptions) => Promise<LoadedConfig>;
  /** Default: the host named in DIGEST_HOST_OS/DIGEST_HOST_ARCH, else the loaded config's, else this process. */
  platform?: Platform;
  /** Process environment; OLLAMA_URL, OLLAMA_MODELS and DIGEST_HOST_* are read. */
  env: Readonly<Record<string, string | undefined>>;
  envPath?: string;
  totalMemoryBytes: number;
  nodeVersion: string;
  homeDir: string;
  /** Bytes free on the disk holding `path` (or its nearest existing parent); undefined when unknown. */
  freeDiskBytes: (path: string) => Promise<number | undefined>;
  /** Asks the Ollama server at `url` for its version and models; never rejects for an unreachable server. */
  ollamaHealth: (url: string) => Promise<ModelHealth>;
  stdout: (text: string) => void;
}

type Verdict = 'ready' | 'pull models' | 'not for this machine';
type VersionStatus = 'ok' | 'too old' | 'unknown';

interface ProfileRow {
  name: RowName;
  profile: Omit<ModelProfile, 'name'>;
  ram: RamFit;
  needsAppleSilicon: boolean;
  hasAppleSilicon: boolean;
  version: VersionStatus;
  /** undefined when Ollama could not list its models. */
  installed: number | undefined;
  total: number;
  missing: string[];
  verdict: Verdict;
}

interface Target {
  dataDir: string;
  ollamaUrl: string;
  platform: Platform;
  /** Why the config was not used, when it was not. */
  configNote: string | undefined;
}

const EXIT_OK = 0;
const EXIT_NONE_FIT = 1;
const HEALTH_TIMEOUT_MS = 10_000;
const DEFAULT_DATA_DIR = ConfigSchema.shape.dataDir.parse(undefined);
const DEFAULT_OLLAMA_URL = EnvSchema.shape.OLLAMA_URL.parse(undefined);
const LOCAL_HOSTS: ReadonlySet<string> = new Set(['localhost', '127.0.0.1', '[::1]']);
const ROW_NAMES: readonly RowName[] = [...ProfileNameSchema.options, 'fallback'];

const defaultIo: ReadinessIo = {
  loadConfig: (options) => loadConfig(options),
  env: process.env,
  totalMemoryBytes: totalmem(),
  nodeVersion: process.version,
  homeDir: homedir(),
  freeDiskBytes,
  ollamaHealth,
  stdout: (text) => {
    process.stdout.write(text);
  },
};

/**
 * `digest doctor --readiness`: the machine summary and a verdict for every profile (W7-02).
 * Contacts only Ollama; no feed, no delivery endpoint. Exit 0 if one profile is ready or needs
 * only pulls, 1 if none can run here.
 */
export async function readinessCommand(
  options: ReadinessCommandOptions,
  overrides: Partial<ReadinessIo> = {},
): Promise<number> {
  const io: ReadinessIo = { ...defaultIo, ...overrides };
  const target = await resolveTarget(options, io);
  const health = await askOllama(target.ollamaUrl, io);
  const rows = ROW_NAMES.map((name) =>
    buildRow(name, target.platform, io.totalMemoryBytes, health),
  );
  const modelsDir = localModelsDir(target.ollamaUrl, io);
  const disk = {
    data: await io.freeDiskBytes(resolve(target.dataDir)),
    models: modelsDir === undefined ? undefined : await io.freeDiskBytes(modelsDir),
  };
  io.stdout(withoutUrlCredentials(render({ target, health, rows, io, modelsDir, disk })));
  return rows.some((row) => row.verdict !== 'not for this machine') ? EXIT_OK : EXIT_NONE_FIT;
}

async function resolveTarget(options: ReadinessCommandOptions, io: ReadinessIo): Promise<Target> {
  try {
    const loaded = await io.loadConfig({
      configPath: options.config,
      envPath: io.envPath,
      platform: io.platform,
    });
    return {
      dataDir: loaded.config.dataDir,
      ollamaUrl: loaded.env.OLLAMA_URL,
      platform: io.platform ?? platformOf(loaded),
      configNote: undefined,
    };
  } catch (error) {
    const fallback = fallbackPlatform(io);
    return {
      dataDir: DEFAULT_DATA_DIR,
      ollamaUrl: urlFromEnv(io.env),
      platform: fallback.platform,
      configNote: [
        `no config used (${errorMessage(error)}); showing defaults`,
        ...(fallback.problem ? [fallback.problem] : []),
      ].join('; '),
    };
  }
}

/** A bad DIGEST_HOST_OS/ARCH is reported, not thrown: this path runs when nothing else could be loaded. */
function fallbackPlatform(io: ReadinessIo): { platform: Platform; problem?: string } {
  if (io.platform) return { platform: io.platform };
  try {
    return { platform: resolveHostPlatform(io.env) };
  } catch (error) {
    return {
      platform: { os: process.platform, arch: process.arch },
      problem: `${errorMessage(error)}; using this process's platform`,
    };
  }
}

function urlFromEnv(env: ReadinessIo['env']): string {
  const parsed = EnvSchema.shape.OLLAMA_URL.safeParse(env['OLLAMA_URL'] ?? undefined);
  return parsed.success ? parsed.data : DEFAULT_OLLAMA_URL;
}

async function askOllama(url: string, io: ReadinessIo): Promise<ModelHealth> {
  try {
    return await io.ollamaHealth(url);
  } catch (error) {
    return { reachable: false, models: [], error: errorMessage(error) };
  }
}

/** The models folder is on this machine only when Ollama is; a remote server's folder is not ours to measure. */
function localModelsDir(ollamaUrl: string, io: ReadinessIo): string | undefined {
  if (!LOCAL_HOSTS.has(new URL(ollamaUrl).hostname)) return undefined;
  const named = io.env['OLLAMA_MODELS']?.trim();
  return named ? resolve(named) : join(io.homeDir, '.ollama', 'models');
}

// ---------------------------------------------------------------------------------------------
// Rows

function buildRow(
  name: RowName,
  platform: Platform,
  totalMemoryBytes: number,
  health: ModelHealth,
): ProfileRow {
  const profile = name === 'fallback' ? NON_MAC_FALLBACK : PROFILES[name];
  const tags = requiredModels({ ...profile, name: 'light' });
  const listed = health.reachable && !health.error;
  const have = new Set(health.models.map((m) => normalizeTag(m.name)));
  const missing = listed ? tags.filter((tag) => !have.has(normalizeTag(tag))) : [...tags];
  const ram = fitsRam(name, totalMemoryBytes);
  const hasAppleSilicon = isAppleSilicon(platform);
  const version = versionStatus(health, profile.minOllamaVersion);
  const fitsHardware = ram !== 'no' && (!profile.requiresAppleSilicon || hasAppleSilicon);
  return {
    name,
    profile,
    ram,
    needsAppleSilicon: profile.requiresAppleSilicon,
    hasAppleSilicon,
    version,
    installed: listed ? tags.length - missing.length : undefined,
    total: tags.length,
    missing,
    verdict: verdictOf(fitsHardware, listed && version !== 'too old' && missing.length === 0),
  };
}

function verdictOf(fitsHardware: boolean, complete: boolean): Verdict {
  if (!fitsHardware) return 'not for this machine';
  return complete ? 'ready' : 'pull models';
}

function versionStatus(health: ModelHealth, minimum: string): VersionStatus {
  if (!health.reachable || health.version === undefined) return 'unknown';
  const actual = parseVersion(health.version);
  const required = parseVersion(minimum);
  if (!actual || !required) return 'unknown';
  if (compareCore(actual.core, DEVELOPMENT_VERSION) === 0) return 'unknown';
  return compareCore(actual.core, required.core) < 0 ? 'too old' : 'ok';
}

// ---------------------------------------------------------------------------------------------
// Output

interface RenderInput {
  target: Target;
  health: ModelHealth;
  rows: readonly ProfileRow[];
  io: ReadinessIo;
  modelsDir: string | undefined;
  disk: { data: number | undefined; models: number | undefined };
}

function render({ target, health, rows, io, modelsDir, disk }: RenderInput): string {
  const lines = [
    ...(target.configNote ? [`! ${target.configNote}`, ''] : []),
    'Machine',
    ...machineLines({ target, health, io, modelsDir, disk }),
    '',
    'Profiles',
    ...tableLines(rows),
    ...pullLines(rows, health),
    '',
  ];
  return `${lines.join('\n')}\n`;
}

function machineLines({
  target,
  health,
  io,
  modelsDir,
  disk,
}: Omit<RenderInput, 'rows'>): string[] {
  const { platform } = target;
  const free = (bytes: number | undefined): string =>
    bytes === undefined ? 'unknown' : formatGiB(bytes);
  const ollama = health.reachable
    ? `${health.version ?? 'unknown version'} at ${target.ollamaUrl}`
    : `not reachable at ${target.ollamaUrl}${health.error ? ` (${health.error})` : ''}`;
  return field([
    ['OS', `${platform.os} (${platform.arch})`],
    ['Apple silicon', isAppleSilicon(platform) ? 'yes' : 'no'],
    ['RAM (seen by this process)', formatGiB(io.totalMemoryBytes)],
    [`Free disk, data dir (${target.dataDir})`, free(disk.data)],
    ...(modelsDir === undefined
      ? []
      : [[`Free disk, Ollama models (${modelsDir})`, free(disk.models)] as const]),
    ['Node', io.nodeVersion],
    ['Ollama', ollama],
    ...(health.reachable && health.error ? [['Ollama models', health.error] as const] : []),
  ]);
}

function field(pairs: readonly (readonly [string, string])[]): string[] {
  const width = Math.max(...pairs.map(([label]) => label.length));
  return pairs.map(([label, value]) => `  ${`${label}:`.padEnd(width + 2)}${value}`);
}

const HEADER = ['profile', 'RAM fits', 'Apple silicon', 'Ollama version', 'models', 'verdict'];

function tableLines(rows: readonly ProfileRow[]): string[] {
  const cells = rows.map((row) => [
    row.name,
    ramCell(row),
    row.needsAppleSilicon
      ? row.hasAppleSilicon
        ? 'needed, present'
        : 'needed, missing'
      : 'not needed',
    versionCell(row),
    row.installed === undefined
      ? `unknown of ${String(row.total)}`
      : `${String(row.installed)} of ${String(row.total)} installed`,
    row.verdict,
  ]);
  const widths = HEADER.map((title, i) =>
    Math.max(title.length, ...cells.map((r) => r[i]?.length ?? 0)),
  );
  const format = (row: readonly string[]): string =>
    `  ${row.map((cell, i) => cell.padEnd(widths[i] ?? 0)).join('  ')}`.trimEnd();
  return [format(HEADER), ...cells.map(format)];
}

function ramCell(row: ProfileRow): string {
  if (row.ram === 'maybe') return 'yes (not measured)';
  return row.ram;
}

function versionCell(row: ProfileRow): string {
  const minimum = row.profile.minOllamaVersion;
  if (row.version === 'ok') return `ok (min ${minimum})`;
  if (row.version === 'too old') return `too old (min ${minimum})`;
  return `unknown (min ${minimum})`;
}

function pullLines(rows: readonly ProfileRow[], health: ModelHealth): string[] {
  const blocks = rows
    .filter((row) => row.verdict === 'pull models')
    .flatMap((row) => [
      '',
      `To get ${row.name} ready:`,
      ...(row.version === 'too old'
        ? [`  update Ollama to ${row.profile.minOllamaVersion} or later`]
        : []),
      ...(health.reachable ? [] : ['  start Ollama ("ollama serve"), then re-run this check']),
      ...row.missing.map((tag) => `  ollama pull ${tag}`),
    ]);
  return blocks;
}

// ---------------------------------------------------------------------------------------------
// Real I/O

/** Free bytes on the disk holding `path`; a path that does not exist yet is judged by its nearest parent. */
async function freeDiskBytes(path: string): Promise<number | undefined> {
  let current = resolve(path);
  for (;;) {
    try {
      const stats = await statfs(current);
      return stats.bavail * stats.bsize;
    } catch {
      const parent = dirname(current);
      if (parent === current) return undefined;
      current = parent;
    }
  }
}

async function ollamaHealth(url: string): Promise<ModelHealth> {
  const provider = createOllamaProvider({
    baseUrl: url,
    profile: PROFILES.light,
    logger: noopLogger,
  });
  return withTimeout(() => provider.health(), HEALTH_TIMEOUT_MS);
}
