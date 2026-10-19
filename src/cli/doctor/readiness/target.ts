import { statfs } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { createOllamaProvider } from '../../../models/adapters/ollama';
import {
  platformOf,
  resolveHostPlatform,
  type LoadedConfig,
  type LoadOptions,
} from '../../../config/load';
import { PROFILES, type Platform } from '../../../config/profiles';
import { ConfigSchema, EnvSchema } from '../../../config/schema';
import type { ModelHealth } from '../../../models/ModelProvider';
import { errorMessage } from '../../../shared/errors';
import { withTimeout } from '../../../shared/retry';
import { noopLogger } from '../../../shared/telemetry';

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

/** Where readiness looks: the data folder, the Ollama server and the host it judges. */
export interface Target {
  dataDir: string;
  ollamaUrl: string;
  platform: Platform;
  /** Why the config was not used, when it was not. */
  configNote: string | undefined;
}

const HEALTH_TIMEOUT_MS = 10_000;
const DEFAULT_DATA_DIR = ConfigSchema.shape.dataDir.parse(undefined);
const DEFAULT_OLLAMA_URL = EnvSchema.shape.OLLAMA_URL.parse(undefined);
const LOCAL_HOSTS: ReadonlySet<string> = new Set(['localhost', '127.0.0.1', '[::1]']);

/**
 * The config's data folder, Ollama URL and host when the config loads. Otherwise the defaults,
 * `OLLAMA_URL` from the environment, and a note saying why the config was not used.
 */
export async function resolveTarget(
  configPath: string | undefined,
  io: ReadinessIo,
): Promise<Target> {
  try {
    const loaded = await io.loadConfig({
      configPath,
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

/** The server's health; a rejection becomes "not reachable" with the reason. */
export async function askOllama(url: string, io: ReadinessIo): Promise<ModelHealth> {
  try {
    return await io.ollamaHealth(url);
  } catch (error) {
    return { reachable: false, models: [], error: errorMessage(error) };
  }
}

/** The models folder is on this machine only when Ollama is; a remote server's folder is not ours to measure. */
export function localModelsDir(
  ollamaUrl: string,
  io: Pick<ReadinessIo, 'env' | 'homeDir'>,
): string | undefined {
  if (!LOCAL_HOSTS.has(new URL(ollamaUrl).hostname)) return undefined;
  const named = io.env['OLLAMA_MODELS']?.trim();
  return named ? resolve(named) : join(io.homeDir, '.ollama', 'models');
}

// ---------------------------------------------------------------------------------------------
// Real I/O

/** Free bytes on the disk holding `path`; a path that does not exist yet is judged by its nearest parent. */
export async function freeDiskBytes(path: string): Promise<number | undefined> {
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

/** Version and models of the Ollama server at `url`, within 10 seconds. `fetchImpl` is for tests. */
export async function ollamaHealth(url: string, fetchImpl?: typeof fetch): Promise<ModelHealth> {
  const provider = createOllamaProvider({
    baseUrl: url,
    profile: PROFILES.light,
    logger: noopLogger,
    fetch: fetchImpl,
  });
  return withTimeout(() => provider.health(), HEALTH_TIMEOUT_MS);
}
