// Offline eval: replays the recorded weeks through runDigest, runs the case sets through the
// steps and guards, and returns the scorecard (W1-22). Models, guards and the digest runner are
// injected, so tests use fakes and `digest eval` wires the real ones. This file only orders the
// work; cases/, replay/, classifierRun/ and scoring/ do it (see evals/CLAUDE.md).
import type { AppHandle } from '../src/app/container';
import { modelsByRole } from '../src/config/profiles';
import type { ProfileName } from '../src/config/schema';
import type { DigestDeps } from '../src/digest/types';
import { errorMessage } from '../src/shared/errors';
import { SPEC_EVAL_SET, type EvalCases, type EvalSetSize, type EvalWeek } from './cases/evalSet';
import { loadEvalCases } from './cases/loadEvalCases';
import { createCheckpoints, fingerprintOf, type Checkpoints } from './checkpoint';
import { replayCodec } from './checkpointReplay';
import type { EvalSection, SavedScorecard } from './checkpointSections';
import { checkGrounding } from './classifierRun/checkGrounding';
import { classifyCases } from './classifierRun/classifyCases';
import type { EvalJudge } from './judge/evalJudge';
import { judgeWinners } from './judge/judgeWinners';
import { replay, type Replay, type ReplayDeps } from './replay/replay';
import { replayAttacks } from './replay/replayAttacks';
import { buildScorecard } from './scoring/buildScorecard';
import { idsOf } from './scoring/replaySamples';
import type { EvalRun, StabilityWeek, WeekRun } from './scoring/types';
import {
  defaultFetcherFactories,
  type SourceFetcherFactories,
} from './sourceConformance/replayFetch/fetcherFactories';
import { evaluateSources } from './sourceConformance/conformance/evaluateSources';

/** Spec: the same week is run 3 times to measure stability. */
const STABILITY_RUNS = 3;

export interface EvalOptions {
  profile: ProfileName;
  /** Folder with weeks/, classifier-cases.json, attacks/, grounding/ and judge/. */
  casesDir: string;
  /** A hard gate fails on a smaller set. Default: the spec's set; lower it while cases are written. */
  minimums?: EvalSetSize;
  /** Run one section and save a partial scorecard. Default: every section. */
  only?: EvalSection;
  /** Save each week replay under `dir`; with `resume`, reuse the ones already there. */
  checkpoints?: { dir: string; resume: boolean; gitSha: string };
}

export interface EvalDeps extends ReplayDeps {
  /** Builds the app for a profile; runEval closes it when done. */
  buildApp: (profile: ProfileName) => Promise<AppHandle>;
  /**
   * Scores the winning draft of each replayed week when the profile has no judge of its own
   * (`EVAL_JUDGE`, system-design D16). Without it, writing quality stays unmeasured there.
   */
  judge?: EvalJudge;
  /** Fetchers run over the source recordings. Default: the real RSS and GitHub fetchers. */
  sourceFetchers?: SourceFetcherFactories;
}

/** Checkpoints for one profile's replays; the fingerprint changes with the config or the git sha. */
function checkpointsFor(options: EvalOptions, app: DigestDeps): Checkpoints | undefined {
  const saved = options.checkpoints;
  if (!saved) return undefined;
  const fingerprint = fingerprintOf({
    gitSha: saved.gitSha,
    profile: options.profile,
    config: app.config,
    models: modelsByRole(app.profile),
  });
  return createCheckpoints({
    dir: saved.dir,
    fingerprint,
    resume: saved.resume,
    warn: (message) => {
      app.logger.warn(message);
    },
  });
}

/** Every week once, then each week's repeats for stability: one model is loaded at a time. */
async function replayWeeks(
  weeks: readonly EvalWeek[],
  replayWeek: (week: EvalWeek, run: number) => Promise<Replay>,
): Promise<{ weekRuns: WeekRun[]; stabilityIds: StabilityWeek[] }> {
  const weekRuns: WeekRun[] = [];
  for (const week of weeks) weekRuns.push({ week, run: await replayWeek(week, 1) });
  const stabilityIds: StabilityWeek[] = [];
  for (const { week, run } of weekRuns) {
    const replays = [run];
    for (let i = 1; i < STABILITY_RUNS; i++) replays.push(await replayWeek(week, i + 1));
    stabilityIds.push({ weekId: week.weekId, runs: replays.map(idsOf), replays });
  }
  return { weekRuns, stabilityIds };
}

async function evaluate(
  cases: EvalCases,
  app: DigestDeps,
  deps: EvalDeps,
  options: EvalOptions,
): Promise<EvalRun> {
  const wants = (section: EvalSection): boolean =>
    options.only === undefined || options.only === section;
  const checkpoints = checkpointsFor(options, app);
  const replayWeek = (week: EvalWeek, run: number): Promise<Replay> => {
    const compute = (): Promise<Replay> => replay(app, deps, week.weekId, week.items);
    return checkpoints
      ? checkpoints.resume(`${options.profile}.${week.weekId}.run${run}`, compute, replayCodec)
      : compute();
  };
  // First, and without a model: the recordings need none.
  const sources = wants('sources')
    ? await evaluateSources(cases.sources, deps.sourceFetchers ?? defaultFetcherFactories)
    : [];
  // One thing at a time: a single model is loaded at a time on the eval machine.
  const { weekRuns, stabilityIds } = await replayWeeks(
    wants('weeks') ? cases.weeks : [],
    replayWeek,
  );
  // The attack replay mixes the attacks into the first recorded week.
  const [firstWeek] = cases.weeks;
  // With the weeks section off, the baseline is replayed here (checkpointed like any week).
  const attackBaseline =
    options.only === 'guards' && firstWeek && cases.attacks.length > 0
      ? await replayWeek(firstWeek, 1)
      : undefined;
  const attack =
    wants('guards') && firstWeek && cases.attacks.length > 0
      ? await replayAttacks(app, deps, firstWeek, cases.attacks)
      : undefined;
  const classifier = wants('classify') ? await classifyCases(app, cases.classifier.cases) : [];
  const grounding = wants('guards')
    ? await checkGrounding(app, cases.grounding)
    : { outcomes: [], tallies: {}, disabledChecks: [] };
  // Last, so the judge model is loaded once, after every replay and every other model call.
  const judged =
    wants('weeks') && deps.judge && app.profile.judge === null
      ? await judgeWinners(
          weekRuns.map(({ run }) => run),
          deps.judge,
          app.logger,
        )
      : undefined;
  return { weekRuns, stabilityIds, attack, attackBaseline, classifier, grounding, judged, sources };
}

/** Runs the whole eval set on one profile and returns its scorecard. Nothing is written. */
export async function runEval(options: EvalOptions, deps: EvalDeps): Promise<SavedScorecard> {
  const startMs = deps.clock.now().getTime();
  const cases = await loadEvalCases(options.casesDir);
  const handle = await deps.buildApp(options.profile);
  try {
    const run = await evaluate(cases, handle.deps, deps, options);
    return buildScorecard({
      profile: options.profile,
      only: options.only,
      cases,
      run,
      app: handle.deps,
      minimums: options.minimums ?? SPEC_EVAL_SET,
      startMs,
      endMs: deps.clock.now().getTime(),
    });
  } finally {
    await handle.close().catch((error: unknown) => {
      handle.deps.logger.warn('Eval could not close the app', { error: errorMessage(error) });
    });
  }
}
