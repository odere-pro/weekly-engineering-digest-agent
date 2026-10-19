import type { LoadedConfig, LoadOptions } from '../../config/load';
import type { Platform } from '../../config/profiles';
import type { ModelProvider } from '../../models/ModelProvider';
import type { Clock } from '../../shared/clock';
import type { ReadinessIo } from './readiness/target';

/** What doctor asks the disk about a path. */
export interface PathInfo {
  mode: number;
  isDirectory: boolean;
  isSymbolicLink: boolean;
}

/** Everything the command touches outside itself; tests replace it, `digest doctor` uses the defaults. */
export interface DoctorIo {
  loadConfig: (options: LoadOptions) => Promise<LoadedConfig>;
  /** The one place doctor builds a model provider; only `health()` is called on it. */
  createProvider: (loaded: LoadedConfig, fetchImpl: typeof fetch) => ModelProvider;
  fetch: typeof fetch;
  clock: Clock;
  /** Passed to the loader. Default: the host named in DIGEST_HOST_OS/DIGEST_HOST_ARCH, else the running process. */
  platform?: Platform;
  /** The .env file to inspect; also where the loader reads secrets from. */
  envPath: string;
  /** Follows symbolic links; rejects with ENOENT when the path (or a link's target) is missing. */
  stat: (path: string) => Promise<PathInfo>;
  /** Does not follow a symbolic link, so a link can be told from what it points at. */
  lstat: (path: string) => Promise<PathInfo>;
  /** The text of a file; rejects with ENOENT when it does not exist. */
  readFile: (path: string) => Promise<string>;
  /** Resolves when `path` is writable, rejects otherwise (ENOENT when it does not exist). */
  access: (path: string) => Promise<void>;
  /** Per-source timeout for the reachability read. */
  sourceTimeoutMs: number;
  stdout: (text: string) => void;
  /** Replaces parts of the `--readiness` mode's I/O (platform, memory, disk, Ollama); tests only. */
  readiness?: Partial<ReadinessIo>;
}
