// Per-replay checkpoints for the eval harness. A full eval is 45 to 110 minutes of GPU, and a run
// that loses Ollama half way would lose it all. Each replay saves its result; a rerun with
// `--resume` reads it back. The file carries a fingerprint (config, profile, git sha), and a file
// with another fingerprint counts as missing.
import { createHash } from 'node:crypto';
import { mkdir, readdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { errorMessage } from '../src/shared/errors';

export interface CheckpointCodec<T> {
  encode: (value: T) => unknown;
  /** undefined when the saved data is not what this code expects: the replay then runs again. */
  decode: (saved: unknown) => T | undefined;
}

export interface Checkpoints {
  /** The saved result under `name` when resuming and it is valid; otherwise `compute()`, saved. */
  resume: <T>(name: string, compute: () => Promise<T>, codec: CheckpointCodec<T>) => Promise<T>;
}

export interface CheckpointOptions {
  /** `<dataDir>/eval/checkpoints/<date>`. */
  dir: string;
  /** From `fingerprintOf`; a saved file with a different one is ignored. */
  fingerprint: string;
  /** Read saved results. Without it checkpoints are only written. */
  resume: boolean;
  warn: (message: string) => void;
}

const UNSAFE_NAME_CHARS = /[^A-Za-z0-9._-]/g;

/** A short, stable hash of anything JSON-like. Same parts in the same order give the same hash. */
export function fingerprintOf(parts: unknown): string {
  return createHash('sha256').update(JSON.stringify(parts)).digest('hex').slice(0, 16);
}

interface CheckpointFile {
  fingerprint: string;
  data: unknown;
}

function isCheckpointFile(value: unknown): value is CheckpointFile {
  return (
    typeof value === 'object' &&
    value !== null &&
    'fingerprint' in value &&
    typeof value.fingerprint === 'string' &&
    'data' in value
  );
}

async function readSaved(path: string): Promise<CheckpointFile | undefined> {
  try {
    const parsed: unknown = JSON.parse(await readFile(path, 'utf8'));
    return isCheckpointFile(parsed) ? parsed : undefined;
  } catch {
    // Missing, half written or not JSON: the replay runs again.
    return undefined;
  }
}

export function createCheckpoints(options: CheckpointOptions): Checkpoints {
  const { dir, fingerprint, warn } = options;
  const pathOf = (name: string): string =>
    join(dir, `${name.replace(UNSAFE_NAME_CHARS, '_')}.json`);

  async function save(path: string, data: unknown): Promise<void> {
    try {
      await mkdir(dir, { recursive: true });
      const temp = `${path}.tmp`;
      await writeFile(temp, JSON.stringify({ fingerprint, data }), 'utf8');
      await rename(temp, path);
    } catch (error) {
      // Losing a checkpoint costs a rerun later; it must not stop the run now.
      warn(`Eval could not save a checkpoint (${path}): ${errorMessage(error)}`);
    }
  }

  return {
    resume: async (name, compute, codec) => {
      const path = pathOf(name);
      if (options.resume) {
        const saved = await readSaved(path);
        const decoded = saved?.fingerprint === fingerprint ? codec.decode(saved.data) : undefined;
        if (decoded !== undefined) return decoded;
      }
      const value = await compute();
      await save(path, codec.encode(value));
      return value;
    },
  };
}

const DATE_FOLDER = /^\d{4}-\d{2}-\d{2}$/;

/**
 * The folder a run uses under `<dataDir>/eval/checkpoints`: today's. When resuming, the newest
 * date folder that exists, so a run lost on one day can be finished on the next.
 */
export async function checkpointDir(root: string, today: string, resume: boolean): Promise<string> {
  if (!resume) return join(root, today);
  try {
    const newest = (await readdir(root))
      .filter((name) => DATE_FOLDER.test(name))
      .sort()
      .at(-1);
    return join(root, newest ?? today);
  } catch {
    return join(root, today);
  }
}
