// The judge that scores the winning digests on a profile without one of its own.
//
// `EVAL_JUDGE` is the ENVIRONMENT VARIABLE (`EnvSchema.EVAL_JUDGE` in config/schema, from `.env` or
// the shell, through `loaded.env`). It is not `OVERRIDE_JUDGE` of config/profiles, which is the judge
// a writers override gives a profile (the model-tag constant that used to share the name).
import {
  assertJudgeInstalled,
  createEvalJudge,
  evalJudgeTag,
  type EvalJudge,
} from '../../../../evals/judge/evalJudge';
import type { LoadedConfig } from '../../../config/load';
import type { ModelProvider } from '../../../models/ModelProvider';
import type { Logger } from '../../../shared/telemetry';

/** What the setup touches outside itself; `EvalCommandIo` has both, so the command passes its own. */
export interface JudgeSetupIo {
  /** The logger the judge's provider writes to, so its retry and timeout warnings show. */
  createEvalLogger: (loaded: LoadedConfig) => Logger;
  /** Builds the judge's model provider: the container's one place for model providers. */
  createProvider: (loaded: LoadedConfig, extras: { logger: Logger }) => ModelProvider;
}

/**
 * The judge named by the EVAL_JUDGE environment variable in `loaded.env`; undefined when it is unset
 * or blank, and the harness then leaves writing quality unmeasured. A tag Ollama cannot serve
 * (unreachable, not installed, not a decision model) throws a DigestError here, before the replay.
 */
export async function prepareEvalJudge(
  loaded: LoadedConfig,
  io: JudgeSetupIo,
): Promise<EvalJudge | undefined> {
  const model = evalJudgeTag(loaded.env);
  if (model === undefined) return undefined;
  // The judge role resolves through the profile, and light and fast have no judge of their own.
  const judging: LoadedConfig = { ...loaded, profile: { ...loaded.profile, judge: model } };
  const provider = io.createProvider(judging, { logger: io.createEvalLogger(loaded) });
  await assertJudgeInstalled(provider, model);
  return createEvalJudge({ provider, model, focusAreas: loaded.config.focusAreas });
}
