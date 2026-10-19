import { buildApp } from '../../../src/app/container';
import { loadConfig, platformOf } from '../../../src/config/load';
import { resolveProfile } from '../../../src/config/profiles';
import type { ProfileName } from '../../../src/config/schema';
import type { Calibration } from '../../../src/process/calibration';
import { systemClock } from '../../../src/shared/clock';
import type { EvalCases } from '../../cases/evalSet';
import { replayRescore } from '../replay/replayRescore';
import type { RescoreResult } from '../replay/types';

export interface RunOptions {
  profile: ProfileName;
  config: string | undefined;
  calibration?: Calibration | undefined;
  pairwise?: boolean;
}

/** The real run: the local config with `options.profile`, the real app's model, closed after. */
export async function runWithApp(
  options: RunOptions,
  cases: EvalCases,
  rescore: boolean,
): Promise<RescoreResult> {
  const loaded = await loadConfig({ configPath: options.config });
  const switched = {
    ...loaded,
    config: { ...loaded.config, profile: options.profile },
    profile: resolveProfile(options.profile, platformOf(loaded), loaded.config.models.writers),
  };
  const app = await buildApp(switched);
  try {
    return await replayRescore(
      cases,
      {
        model: app.deps.model,
        config: switched.config,
        logger: app.deps.logger,
        clock: systemClock,
        calibration: options.calibration,
        pairwise: options.pairwise,
      },
      rescore,
    );
  } finally {
    await app.close();
  }
}
