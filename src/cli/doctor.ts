import { NotImplementedError } from '../shared/errors.js';

export interface DoctorCommandOptions {
  /** Path to digest.config.json. */
  config?: string;
}

/** `digest doctor`: Checks Ollama, the models, every feed and delivery; prints what to fix (W1-19). Returns the process exit code. */
export function doctorCommand(_options: DoctorCommandOptions): Promise<number> {
  throw new NotImplementedError('W1-19');
}
