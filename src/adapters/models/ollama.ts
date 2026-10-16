import type { ModelProfile } from '../../config/profiles.js';
import type { Role } from '../../core/schemas.js';
import type { ModelProvider } from '../../ports/ModelProvider.js';
import { NotImplementedError } from '../../shared/errors.js';
import type { Logger } from '../../shared/telemetry.js';

export interface OllamaProviderOptions {
  baseUrl: string;
  profile: ModelProfile;
  timeoutsMs?: Partial<Record<Role, number>>;
  /** Spec: 2 retries with backoff. */
  retries?: number;
  fetch?: typeof fetch;
  logger: Logger;
}

/** ModelProvider on Ollama: /api/chat for generate, /v1/systemone for decide (W1-04). */
export function createOllamaProvider(_options: OllamaProviderOptions): ModelProvider {
  throw new NotImplementedError('W1-04');
}
