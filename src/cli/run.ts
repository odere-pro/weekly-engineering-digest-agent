import { NotImplementedError } from '../shared/errors.js';

export interface RunCommandOptions {
  /** Path to digest.config.json. */
  config?: string;
  /** Collection window, e.g. "7d"; defaults to config.windowDays. */
  since?: string;
  dryRun?: boolean;
  force?: boolean;
}

/** `digest run`: One full run; --dry-run writes the digest to disk and sends nothing (W1-17). Returns the process exit code. */
export function runCommand(_options: RunCommandOptions): Promise<number> {
  throw new NotImplementedError('W1-17');
}
