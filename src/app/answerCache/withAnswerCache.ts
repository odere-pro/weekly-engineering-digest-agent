import type { LoadedConfig } from '../../config/load';
import { effectiveTemperature, effectiveThink } from '../../models/adapters/chat/chatSettings';
import type { ModelProvider } from '../../models/ModelProvider';
import type { Redactor } from '../../observability/redact';
import type { Logger } from '../../shared/telemetry';
import { createAnswerStore } from './answerStore';
import { cacheAnswers } from './cachedModel';

/** What the container knows about the run in flight. */
interface RunAccess {
  /**
   * False hands the provider back as it is. `digest eval` builds the app so: its replays measure
   * the models, run each week three times, and must write no file into the data folder.
   */
  enabled: boolean;
  /** The week of the run in flight; undefined outside a run. */
  week: () => string | undefined;
  redactor: Redactor;
  logger: Logger;
}

/**
 * The provider with the week's answer cache (`cachedModel.ts`): a rerun of a week reuses what an
 * earlier run asked the same model, so guards and classify do not run twice. Outside a run, and
 * before the run's health check names the model digests, every call goes straight through.
 */
export function withAnswerCache(
  provider: ModelProvider,
  { config, profile }: LoadedConfig,
  run: RunAccess,
): ModelProvider {
  if (!run.enabled) return provider;
  return cacheAnswers(provider, {
    store: createAnswerStore({
      dataDir: config.dataDir,
      redact: (text) => run.redactor.text(text),
    }),
    profile,
    week: run.week,
    sampling: (role) => ({
      temperature: effectiveTemperature(config.models.temperature, role),
      seed: config.models.seed,
      think: effectiveThink(config.models.think, role),
    }),
    logger: run.logger,
  });
}
