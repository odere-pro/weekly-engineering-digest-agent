import { NotImplementedError } from '../shared/errors.js';

export interface EvalCommandOptions {
  /** Path to digest.config.json. */
  config?: string;
  /** Profile name, or "all". Defaults to the configured profile. */
  profile?: string;
}

/** `digest eval`: Runs the eval set and prints the scorecard (W1-22). Returns the process exit code. */
export function evalCommand(_options: EvalCommandOptions): Promise<number> {
  throw new NotImplementedError('W1-22');
}
