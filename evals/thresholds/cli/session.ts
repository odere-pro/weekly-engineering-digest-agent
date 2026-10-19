// The capture session: the app `digest run` would build, checked against Ollama before any call.
import type { AppHandle } from '../../../src/app/container';
import type { GuardCheckId } from '../../../src/guards/guardVerdict';
import type { ModelProvider } from '../../../src/models/ModelProvider';
import { DigestError } from '../../../src/shared/errors';
import type { CaptureSession } from './io';

function guardById<G extends { id: GuardCheckId }>(guards: readonly G[], id: GuardCheckId): G {
  const guard = guards.find((g) => g.id === id);
  if (!guard) throw new DigestError(`The app has no ${id} guard`);
  return guard;
}

/** The Ollama version, once Ollama answers and has every tag in `tags`. */
async function installedVersion(
  model: ModelProvider,
  tags: readonly string[],
): Promise<string | null> {
  const health = await model.health();
  if (!health.reachable)
    throw new DigestError(`Ollama is not reachable: ${health.error ?? 'no answer'}`);
  const installed = new Set(health.models.map((m) => m.name));
  const missing = [...new Set(tags)].filter((tag) => !installed.has(tag));
  if (missing.length > 0)
    throw new DigestError(`Ollama lacks ${missing.join(', ')}; ask the maintainer to pull it`);
  return health.version ?? null;
}

async function sessionOf(app: AppHandle): Promise<CaptureSession> {
  const { config, profile, model, inputGuards, outputGuards, logger } = app.deps;
  const models = {
    classify: profile.classify,
    guardPolicy: profile.guardPolicy,
    guardRisk: profile.guardRisk,
  };
  return {
    profile: profile.name,
    models,
    ollamaVersion: await installedVersion(model, Object.values(models)),
    baseline: config.thresholds,
    deps: {
      model,
      focusAreas: config.focusAreas,
      clefPolicy: guardById(inputGuards, 'clefPolicy'),
      graniteRisk: guardById(inputGuards, 'graniteRisk'),
      clefRubric: guardById(outputGuards, 'clefRubric'),
      logger,
    },
    close: () => app.close(),
  };
}

/** A capture session on the app `digest run` would build. Closes the app when it cannot start. */
export async function captureSession(app: AppHandle): Promise<CaptureSession> {
  try {
    return await sessionOf(app);
  } catch (error) {
    await app.close();
    throw error;
  }
}
