import type { ModelProfile } from '../../../config/profiles';
import type { LogFields, Logger } from '../../../shared/telemetry';
import type { Role } from '../../roles';
import type { OllamaHttp } from '../ollamaHttp';
import type { LoadTracker } from './loadTracker';

/** The provider options every model call reads. */
export interface CallOptions {
  profile: ModelProfile;
  logger: Logger;
  /** Per-role timeout for one attempt; a role without one uses `DEFAULT_TIMEOUTS_MS`. */
  timeoutsMs?: Partial<Record<Role, number>>;
  /** Extra attempts after the first; unset means the adapter default. */
  retries?: number;
  /**
   * The wait before the first retry, doubling for each one after it (capped at 10 s). Unset means
   * 1 s. For tests, so a failing call does not spend seconds in a real backoff.
   */
  retryBaseDelayMs?: number;
  /**
   * Time added to every attempt's timeout while the call's model is not the one the server ran
   * last: it may have to be loaded first, and a big model loads for longer than a role's timeout.
   * Unset means `DEFAULT_COLD_START_MS`; 0 turns it off.
   */
  coldStartMs?: number;
}

/** The transport and options a call runs on. */
export interface OllamaContext {
  http: OllamaHttp;
  options: CallOptions;
  /** Which model the server ran last; one per provider, shared by all its calls. */
  loads: LoadTracker;
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
