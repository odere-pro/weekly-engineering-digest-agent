import { modelsInUse } from '../../config/profiles';
import type { ModelHealth, ModelProvider } from '../../models/ModelProvider';
import { DigestError, errorMessage } from '../../shared/errors';
import type { Logger } from '../../shared/telemetry';
import type { DigestDeps } from '../types';

/** What the check reads from the run: the model port, the profile and config, and the logger. */
export interface HealthContext {
  readonly deps: Pick<DigestDeps, 'model' | 'profile' | 'config'>;
  readonly logger: Logger;
}

/**
 * Ollama must be up and have every model this run uses before anything is collected. The model
 * of a guard role whose checks are all off is not needed (F30).
 */
export async function assertModelsReady(ctx: HealthContext): Promise<void> {
  const { model, profile, config } = ctx.deps;
  const health = await readHealth(model);
  if (!health.reachable) {
    const reason = health.error ? `: ${health.error}` : '';
    throw new DigestError(`Ollama is not reachable${reason}. Start Ollama and run again.`);
  }
  const required = modelsInUse(profile, config.guards);
  const available = new Set(health.models.map((entry) => withTag(entry.name)));
  const missing = required.filter((tag) => !available.has(withTag(tag)));
  if (missing.length > 0) {
    throw new DigestError(
      `Ollama is missing models for profile "${profile.name}": ${missing.join(', ')}. ` +
        'Pull them with "ollama pull <model>".',
    );
  }
  ctx.logger.info('Models ready', { profile: profile.name, models: required });
}

async function readHealth(model: ModelProvider): Promise<ModelHealth> {
  try {
    return await model.health();
  } catch (error) {
    return { reachable: false, models: [], error: errorMessage(error) };
  }
}

/** Ollama lists "clef:latest" for a model pulled as "clef". */
function withTag(name: string): string {
  return name.includes(':') ? name : `${name}:latest`;
}
