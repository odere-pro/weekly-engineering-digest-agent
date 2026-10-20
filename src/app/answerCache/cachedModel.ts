import type { ModelProfile } from '../../config/profiles';
import { resolveModel } from '../../models/adapters/call/resolveModel';
import type {
  DecideResult,
  GenerateRequest,
  GenerateResult,
  ModelHealth,
  ModelProvider,
  Usage,
} from '../../models/ModelProvider';
import type { Role } from '../../models/roles';
import { errorMessage } from '../../shared/errors';
import type { Logger } from '../../shared/telemetry';
import { decorate, type MemberRules } from '../decorate';
import { decideKey, generateKey, type ModelIdentity, type SamplingSettings } from './answerKey';
import type { AnswerStore, StoredAnswer } from './answerStore';

export interface AnswerCacheOptions {
  store: AnswerStore;
  profile: ModelProfile;
  /** The week of the run in flight; undefined outside a run, which passes every call through. */
  week: () => string | undefined;
  /** What a `generate` call of `role` sends when the request sets no temperature or seed. */
  sampling: (role: Role) => SamplingSettings;
  logger: Logger;
}

/** A reused answer cost no tokens and no model time. */
const NO_USAGE: Usage = { inputTokens: 0, outputTokens: 0 };

/** Writers sample above 0 and are the step a rerun may want fresh: never reused. */
const NEVER_CACHED: ReadonlySet<Role> = new Set(['write']);

interface ServerFacts {
  version: string;
  digests: ReadonlyMap<string, string>;
}

interface WeekAnswers {
  weekId: string;
  entries: Map<string, StoredAnswer>;
  saving: boolean;
}

/** Where one call's answer lives: the week's answers and the call's key. */
interface Slot {
  week: WeekAnswers;
  key: string;
}

/** `clef` and `clef:latest` are one tag to Ollama; `/api/tags` lists the long form. */
function withLatest(tag: string): string {
  const name = tag.split('/').pop() ?? tag;
  return name.includes(':') ? tag : `${tag}:latest`;
}

function serverFacts(health: ModelHealth): ServerFacts | undefined {
  if (!health.reachable || health.version === undefined) return undefined;
  const digests = new Map(
    health.models.flatMap((model): [string, string][] =>
      model.digest ? [[model.name, model.digest]] : [],
    ),
  );
  return { version: health.version, digests };
}

/** The decorator's state: the server facts of the last health check and the week in flight. */
class AnswerCache {
  private server: ServerFacts | undefined;
  private current: { weekId: string; answers: Promise<WeekAnswers> } | undefined;
  private readonly undigested = new Set<string>();

  constructor(readonly options: AnswerCacheOptions) {}

  /**
   * `runDigest` asks `health()` first in every run: take the server facts from it, and read the
   * week file again, so a pull, a deleted file or a prune between two runs of `serve` counts.
   */
  observe(health: ModelHealth): void {
    this.server = serverFacts(health);
    this.current = undefined;
  }

  /** The slot of a call, or undefined when it must go to the model as it is. */
  async slot(
    role: Role,
    explicitModel: string | undefined,
    keyOf: (identity: ModelIdentity) => string,
  ): Promise<Slot | undefined> {
    const weekId = this.options.week();
    if (weekId === undefined || NEVER_CACHED.has(role)) return undefined;
    const identity = this.identity(role, explicitModel);
    if (identity === undefined) return undefined;
    return { week: await this.weekAnswers(weekId), key: keyOf(identity) };
  }

  reused(role: Role, answer: StoredAnswer): void {
    this.options.logger.debug('model answer reused', { role, model: answer.model, op: answer.op });
  }

  async remember(slot: Slot, answer: StoredAnswer): Promise<void> {
    slot.week.entries.set(answer.key, answer);
    if (!slot.week.saving) return;
    try {
      await this.options.store.append(slot.week.weekId, answer);
    } catch (error) {
      slot.week.saving = false;
      this.options.logger.warn(
        'Answer cache could not be saved; answers are kept for this run only',
        { error: errorMessage(error) },
      );
    }
  }

  private identity(role: Role, explicitModel: string | undefined): ModelIdentity | undefined {
    if (this.server === undefined) return undefined;
    let model: string;
    try {
      model = resolveModel(this.options.profile, role, explicitModel);
    } catch {
      // A role with no model: the model call itself reports it.
      return undefined;
    }
    const digest = this.server.digests.get(model) ?? this.server.digests.get(withLatest(model));
    if (digest !== undefined) return { serverVersion: this.server.version, model, digest };
    if (!this.undigested.has(model)) {
      this.undigested.add(model);
      this.options.logger.warn('Answer cache is off for a model Ollama lists no digest for', {
        model,
      });
    }
    return undefined;
  }

  private weekAnswers(weekId: string): Promise<WeekAnswers> {
    if (this.current?.weekId !== weekId) {
      this.current = { weekId, answers: this.load(weekId) };
    }
    return this.current.answers;
  }

  private async load(weekId: string): Promise<WeekAnswers> {
    const { logger, store } = this.options;
    try {
      const { entries, skipped } = await store.load(weekId);
      if (skipped > 0) logger.warn('Answer cache skipped unreadable lines', { skipped });
      logger.info('Answer cache loaded', { answers: entries.size });
      return { weekId, entries, saving: true };
    } catch (error) {
      logger.warn('Answer cache could not be read; this run starts without it', {
        error: errorMessage(error),
      });
      return { weekId, entries: new Map(), saving: false };
    }
  }
}

/** The temperature, seed and think a generate call sends; the request's own values win. */
function samplingOf(cache: AnswerCache, request: GenerateRequest): SamplingSettings {
  const defaults = cache.options.sampling(request.role);
  return {
    ...defaults,
    temperature: request.temperature ?? defaults.temperature,
    seed: request.seed ?? defaults.seed,
  };
}

const CACHE_RULES: MemberRules<ModelProvider, AnswerCache> = {
  decide: (model, cache) => async (request) => {
    const slot = await cache.slot(request.role, undefined, (id) => decideKey(id, request));
    if (slot === undefined) return model.decide(request);
    const saved = slot.week.entries.get(slot.key);
    if (saved?.op === 'decide') {
      request.signal?.throwIfAborted();
      cache.reused(request.role, saved);
      const reused: DecideResult = {
        model: saved.model,
        answers: saved.answers,
        usage: NO_USAGE,
        latencyMs: 0,
      };
      return reused;
    }
    const result = await model.decide(request);
    await cache.remember(slot, {
      key: slot.key,
      op: 'decide',
      model: result.model,
      answers: result.answers,
    });
    return result;
  },
  generate: (model, cache) => async (request) => {
    const sampling = samplingOf(cache, request);
    if (sampling.temperature !== 0) return model.generate(request);
    const slot = await cache.slot(request.role, request.model, (id) =>
      generateKey(id, request, sampling),
    );
    if (slot === undefined) return model.generate(request);
    const saved = slot.week.entries.get(slot.key);
    if (saved?.op === 'generate') {
      request.signal?.throwIfAborted();
      cache.reused(request.role, saved);
      const reused: GenerateResult = {
        model: saved.model,
        text: saved.text,
        usage: NO_USAGE,
        latencyMs: 0,
      };
      return reused;
    }
    const result = await model.generate(request);
    await cache.remember(slot, {
      key: slot.key,
      op: 'generate',
      model: result.model,
      text: result.text,
    });
    return result;
  },
  health: (model, cache) => async () => {
    const health = await model.health();
    cache.observe(health);
    return health;
  },
};

/**
 * The same provider, reusing the answers a week's earlier runs got for the very same call (PERF-1).
 * A key covers the Ollama version, the model digest from the last `health()` and every byte the
 * model reads, so a new pull, an Ollama upgrade or any prompt change asks the model again. It
 * reuses `decide` answers and temperature-0 `generate` answers, never a writer's. Outside a run, or
 * before `health()` names the model's digest, every call goes straight through.
 */
export function cacheAnswers(model: ModelProvider, options: AnswerCacheOptions): ModelProvider {
  return decorate(model, new AnswerCache(options), CACHE_RULES);
}
