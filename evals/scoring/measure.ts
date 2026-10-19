import type { RunRecord } from '../../src/store/runRecord';
import type { GroundingResults } from '../classifierRun/checkGrounding';
import { judgedQuality } from '../judge/judgeWinners';
import { withCoverage } from '../metrics';
import { attackHandling } from '../metrics/attacks/attackHandling';
import { attackRunMeasurement } from '../metrics/attacks/attackRun';
import { guardAttackRecall } from '../metrics/attacks/guardAttackRecall';
import { factCarry } from '../metrics/digest/factCarry';
import { formatCompliance } from '../metrics/digest/formatCompliance';
import { linkValidity } from '../metrics/digest/linkValidity';
import { groundedness } from '../metrics/guards/groundedness';
import { guardFalseBlocks } from '../metrics/guards/guardFalseBlocks';
import { guardRealBlocks } from '../metrics/guards/guardRealBlocks';
import { writingQuality } from '../metrics/judging/judgeMetrics';
import { writerWinRate } from '../metrics/judging/writerWinRate';
import type { Measurement } from '../metrics/measurement/measurement';
import { classifierRanking } from '../metrics/ranking/classifier';
import { mustExcludeLeaks, mustIncludeRecall } from '../metrics/ranking/labelHits';
import { runTime } from '../metrics/run/runTime';
import { sourceParse, sourceSummaryFill } from '../metrics/sources/sourceMetrics';
import { tallyOf } from '../replay/guardVerdicts';
import type { Replay } from '../replay/replay';
import type { JudgeCalibration, MetricId } from '../schema';
import { hitsOf, replayEndOf, sampleOf } from './replaySamples';
import { stabilityAcrossWeeks } from './stabilityAcrossWeeks';
import type { AttackReplay, Scoring } from './types';

/** The judge's calibration only means something for a profile that has a judge. */
export const calibrationFor = ({ app, cases }: Scoring): JudgeCalibration | null =>
  app.profile.judge === null ? null : cases.calibration;

/** The judge score of the draft the run picked, if it has one. */
export function winnerScore(record: RunRecord): number | undefined {
  return record.drafts.find((draft) => draft.writer === record.winner)?.score?.score;
}

/** The first week's plain replay is the baseline the attack replay is compared with. */
export function attackMeasurement(
  attack: AttackReplay | undefined,
  baseline: Replay | undefined,
): Measurement {
  if (!attack) return attackHandling([]);
  const { status, disabledGuards, drafts } = attack.run.record;
  return attackRunMeasurement(
    { status, disabledGuards, drafts, baselineStatus: baseline?.record.status },
    attack.outcomes,
  );
}

export function groundingMeasurement(grounding: GroundingResults): Measurement {
  if (grounding.disabledChecks.length > 0) {
    return { value: null, note: `guards were off: ${grounding.disabledChecks.join(', ')}` };
  }
  return groundedness(grounding.outcomes);
}

/** Wraps a measurement so a set smaller than the spec's cannot pass a hard gate. */
function coverage({ cases, minimums }: Scoring) {
  return {
    weeks: (m: Measurement): Measurement =>
      withCoverage(m, cases.weeks.length, minimums.weeks, 'weeks'),
    attacks: (m: Measurement): Measurement =>
      withCoverage(m, cases.attacks.length, minimums.attacks, 'attack cases'),
    grounding: (m: Measurement): Measurement =>
      withCoverage(m, cases.grounding.length, minimums.grounding, 'grounding cases'),
    classifier: (m: Measurement): Measurement =>
      withCoverage(m, cases.classifier.cases.length, minimums.classifier, 'classifier cases'),
  };
}

function classifierMeasurement({ cases, run }: Scoring): Measurement {
  const unreviewed = cases.classifier.cases.length > 0 && !cases.classifier.reviewed;
  return {
    ...classifierRanking(run.classifier),
    ...(unreviewed ? { note: 'labels not reviewed by the maintainer yet' } : {}),
  };
}

/** One measurement per metric id, before the gates and labels of `assembleMetrics`. */
export function measure(scoring: Scoring): Record<MetricId, Measurement> {
  const { run } = scoring;
  const calibration = calibrationFor(scoring);
  const covered = coverage(scoring);
  const weekSamples = run.weekRuns.map(({ run: r }) => sampleOf(r));
  const attackSamples = run.attack
    ? [{ ...sampleOf(run.attack.run), label: `${run.attack.run.weekId} (attacks)` }]
    : [];
  const hits = run.weekRuns.map(hitsOf);
  const inputTallies = tallyOf(
    run.weekRuns.flatMap(({ run: r }) => r.inputVerdicts.map((v) => v.verdict)),
  );
  const records = run.weekRuns.map(({ run: r }) => r.record);
  return {
    linkValidity: covered.weeks(linkValidity([...weekSamples, ...attackSamples])),
    attackHandling: covered.attacks(
      attackMeasurement(run.attack, run.attackBaseline ?? run.weekRuns[0]?.run),
    ),
    sourceParse: sourceParse(run.sources),
    sourceSummaryFill: sourceSummaryFill(run.sources),
    guardAttackRecall: covered.attacks(
      guardAttackRecall(run.attack?.outcomes ?? [], run.attack?.run.record.disabledGuards ?? []),
    ),
    groundedness: covered.grounding(groundingMeasurement(run.grounding)),
    format: covered.weeks(formatCompliance(weekSamples)),
    factCarry: covered.weeks(factCarry(weekSamples)),
    guardFalseBlocks: guardFalseBlocks({ ...inputTallies, ...run.grounding.tallies }),
    guardRealBlocks: covered.weeks(
      guardRealBlocks(run.stabilityIds.flatMap((w) => w.replays).map(replayEndOf)),
    ),
    mustIncludeRecall: covered.weeks(mustIncludeRecall(hits)),
    mustExcludeLeaks: covered.weeks(mustExcludeLeaks(hits)),
    classifierAccuracy: covered.classifier(classifierMeasurement(scoring)),
    writingQuality: run.judged
      ? judgedQuality(run.judged)
      : writingQuality(records.flatMap((record) => winnerScore(record) ?? [])),
    // Measured once on the hand-graded digests (W3-04), not on every eval run.
    selectionAgreement: calibration
      ? { value: calibration.selectionAgreement, note: 'from judge/calibration.json' }
      : { value: null },
    writerWinRate: writerWinRate(records.flatMap((record) => record.winner ?? [])),
    stability: stabilityAcrossWeeks(run.stabilityIds),
    runTime: runTime(run.weekRuns.map(({ run: r }) => r.durationMs)),
  };
}
