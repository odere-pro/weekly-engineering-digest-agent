// The judge `digest eval` uses on a profile that has none (system-design D16, F10). The select
// step skips the judge when `profile.judge` is null, so on `fast` and `light` the harness asks the
// judge model itself, with the same rubric, about the winning draft of each replayed week.
import type { Env } from '../../src/config/schema.js';
import {
  buildJudgeQuestions,
  buildJudgeState,
  resolveDraftSources,
} from '../../src/core/prompts/judge.js';
import type { Draft, Item, JudgeScore } from '../../src/core/schemas.js';
import { toJudgeScore } from '../../src/core/steps/select.js';
import type { ModelProvider } from '../../src/ports/ModelProvider.js';
import { DigestError } from '../../src/shared/errors.js';

/** The `user:pass@` in a URL such as `https://user:pass@host`; `digest doctor` strips it the same way. */
const URL_CREDENTIALS = /(\bhttps?:\/\/)[^\s/@]+@/g;

/** Scores one draft against the items it cites. */
export interface EvalJudge {
  /** Tag of the judge model; goes into the scorecard's `models`. */
  model: string;
  score(draft: Draft, sources: readonly Item[]): Promise<JudgeScore>;
}

export interface EvalJudgeOptions {
  /**
   * A provider whose profile names `model` as its judge (`{ ...profile, judge: model }`): the
   * judge role resolves to a tag through the profile, and a single-writer profile has none.
   */
  provider: ModelProvider;
  model: string;
  focusAreas: readonly string[];
}

/**
 * The judge model tag from the loaded environment (`EVAL_JUDGE=clef:latest`, from `.env` or the
 * shell as `loadConfig` merges them); undefined when unset or blank.
 */
export function evalJudgeTag(env: Pick<Env, 'EVAL_JUDGE'>): string | undefined {
  const tag = env.EVAL_JUDGE?.trim();
  return tag === undefined || tag === '' ? undefined : tag;
}

export function createEvalJudge({ provider, model, focusAreas }: EvalJudgeOptions): EvalJudge {
  const questions = buildJudgeQuestions(focusAreas);
  return {
    model,
    score: async (draft, sources) => {
      const { found } = resolveDraftSources(draft, sources);
      const result = await provider.decide({
        role: 'judge',
        state: buildJudgeState(draft, found),
        questions,
      });
      return toJudgeScore(draft.writer, result.answers);
    },
  };
}

/**
 * Fails before a long replay starts when Ollama cannot serve the judge: unreachable, the tag not
 * installed, or not a decision model. It only reads the model list; it never pulls a model.
 */
export async function assertJudgeInstalled(
  provider: Pick<ModelProvider, 'health'>,
  tag: string,
): Promise<void> {
  const health = await provider.health();
  if (!health.reachable || health.error !== undefined) {
    // The reason names the Ollama URL, which may carry credentials: they must not reach the terminal.
    const reason = (health.error ?? 'Ollama is not reachable.').replace(URL_CREDENTIALS, '$1');
    throw new DigestError(
      `Cannot check the eval judge "${tag}" (EVAL_JUDGE), so nothing was replayed. ${reason}`,
    );
  }
  const wanted = normalizeTag(tag);
  const model = health.models.find((candidate) => normalizeTag(candidate.name) === wanted);
  if (model === undefined) {
    throw new DigestError(
      `The eval judge "${tag}" (EVAL_JUDGE) is not installed in Ollama, so nothing was replayed. ` +
        `Install it with "ollama pull ${tag}", or set EVAL_JUDGE to a model "ollama list" shows.`,
    );
  }
  if (!model.capabilities.includes('decision')) {
    throw new DigestError(
      `The eval judge "${tag}" (EVAL_JUDGE) is installed, but it is not a decision model ` +
        '(no "decision" capability), so nothing was replayed. Set EVAL_JUDGE to a decision model.',
    );
  }
}

/** Ollama lists an untagged name as ":latest" (the same rule `digest doctor` applies). */
function normalizeTag(tag: string): string {
  const name = tag.slice(tag.lastIndexOf('/') + 1); // a registry port ("host:5000/x") is not a version
  return name.includes(':') ? tag : `${tag}:latest`;
}
