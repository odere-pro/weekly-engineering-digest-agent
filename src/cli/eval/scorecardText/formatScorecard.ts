// The scorecard `digest eval` prints, as plain text. Pure: no I/O, no model.
import type { SavedScorecard } from '../../../../evals/checkpointSections';
import { failedHardGates } from '../../../../evals/metrics';
import { METRIC_IDS } from '../../../../evals/schema';
import { gateCell, resultCell, table, valueCell } from './cells';
import { ITEM_IDS_TITLE, itemIdsByRunLines } from './itemIds';
import { weekProblemLines } from './weekProblems';

const DETAIL_DECIMALS = 3;
const PERCENT = 100;

function detailText(detail: Readonly<Record<string, number>>): string {
  return Object.entries(detail)
    .map(([key, value]) => `${key}=${Number(value.toFixed(DETAIL_DECIMALS))}`)
    .join(', ');
}

/** A titled block after a blank line; nothing when there are no lines. */
function section(title: string, lines: readonly string[]): string[] {
  return lines.length > 0 ? ['', title, ...lines] : [];
}

/** The scorecard as plain text: header, metric table, details, problems, notes and the verdict. */
export function formatScorecard(scorecard: SavedScorecard): string {
  const metrics = METRIC_IDS.map((id) => scorecard.metrics[id]);
  const { counts } = scorecard;
  const judge =
    scorecard.judgeAgreement === null
      ? 'not calibrated'
      : `${Math.round(scorecard.judgeAgreement * PERCENT)}%`;
  const failed = failedHardGates(scorecard.metrics);
  const details = metrics.flatMap((m) =>
    m.detail ? [`  ${m.label}: ${detailText(m.detail)}`] : [],
  );
  const notes = metrics.flatMap((m) => (m.note ? [`  ${m.label}: ${m.note}`] : []));
  return [
    `Eval scorecard: ${scorecard.profile} (${scorecard.date.slice(0, 10)})`,
    ...(scorecard.partial
      ? [
          `Partial run: ${scorecard.partial.join(', ')}. Other metrics are not run; gates are reported, not enforced.`,
        ]
      : []),
    `Cases: ${counts.weeks} weeks, ${counts.classifier} classifier, ${counts.attacks} attacks, ${counts.grounding} grounding`,
    `Judge agreement: ${judge}`,
    '',
    ...table([
      ['Metric', 'Value', 'Gate', 'Result'],
      ...metrics.map((m) => [m.label, valueCell(m), gateCell(m), resultCell(m)]),
    ]),
    ...section('Details:', details),
    ...section('Week problems:', weekProblemLines(metrics)),
    ...section(ITEM_IDS_TITLE, itemIdsByRunLines(metrics)),
    ...section('Notes:', notes),
    '',
    failed.length === 0 ? 'Hard gates: PASS' : `Hard gates: FAIL (${failed.join(', ')})`,
  ].join('\n');
}
