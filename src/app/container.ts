// Composition root: the only place that turns config into real adapters.
import type { DigestDeps } from '../core/runDigest.js';
import type { LoadedConfig } from '../config/load.js';
import { NotImplementedError } from '../shared/errors.js';

export interface AppHandle {
  deps: DigestDeps;
  /** Flushes traces and closes resources. */
  close(): Promise<void>;
}

/** Builds DigestDeps from the loaded config (W2-02). */
export function buildApp(_loaded: LoadedConfig): Promise<AppHandle> {
  throw new NotImplementedError('W2-02');
}
