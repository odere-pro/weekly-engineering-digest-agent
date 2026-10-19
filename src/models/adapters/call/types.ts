import type { ModelProfile } from '../../../config/profiles';
import type { LogFields, Logger } from '../../../shared/telemetry';
import type { Role } from '../../roles';
import type { OllamaHttp } from '../ollamaHttp';

/** The provider options every model call reads. */
export interface CallOptions {
  profile: ModelProfile;
  logger: Logger;
  /** Per-role timeout for one attempt; a role without one uses `DEFAULT_TIMEOUTS_MS`. */
  timeoutsMs?: Partial<Record<Role, number>>;
  /** Extra attempts after the first; unset means the adapter default. */
  retries?: number;
}

/** The transport and options a call runs on. */
export interface OllamaContext {
  http: OllamaHttp;
  options: CallOptions;
}

export interface CallSpec {
  op: 'generate' | 'decide';
  role: Role;
  model: string;
  signal: AbortSignal | undefined;
  /** Extra fields for this call's log lines. */
  logFields?: LogFields;
  /** One attempt; `signal` combines the caller's signal and the attempt timeout. */
  send: (signal: AbortSignal) => Promise<unknown>;
}
