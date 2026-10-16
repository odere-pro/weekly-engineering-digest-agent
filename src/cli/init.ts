import { NotImplementedError } from '../shared/errors.js';

export interface InitCommandOptions {
  /** Path to digest.config.json. */
  config?: string;
  /** Accept defaults without prompting. */
  yes?: boolean;
}

/** `digest init`: Asks for focus areas, delivery and profile, then writes digest.config.json and .env (W1-18). Returns the process exit code. */
export function initCommand(_options: InitCommandOptions): Promise<number> {
  throw new NotImplementedError('W1-18');
}
