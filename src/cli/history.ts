import { NotImplementedError } from '../shared/errors.js';

export interface HistoryCommandOptions {
  /** Path to digest.config.json. */
  config?: string;
  limit?: number;
}

/** `digest history`: Lists past runs with status, item counts and duration (W1-17). Returns the process exit code. */
export function historyCommand(_options: HistoryCommandOptions): Promise<number> {
  throw new NotImplementedError('W1-17');
}
