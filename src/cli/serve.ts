import { NotImplementedError } from '../shared/errors.js';

export interface ServeCommandOptions {
  /** Path to digest.config.json. */
  config?: string;
}

/** `digest serve`: Runs the in-process weekly scheduler (Docker Compose service) (W1-16). Returns the process exit code. */
export function serveCommand(_options: ServeCommandOptions): Promise<number> {
  throw new NotImplementedError('W1-16');
}
