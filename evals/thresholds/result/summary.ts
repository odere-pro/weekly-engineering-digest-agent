// The text `sweep` prints for a tuning result: the thresholds, the headline numbers and, for a
// result with a train and holdout split, the two sides side by side.
import { fixed, splitLines } from '../split';
import type { TuningResult } from './schema';

const THRESHOLD_KEYS = ['minRelevance', 'maxHype', 'maxMinorRelease', 'guardFlag'] as const;

function splitSection({ split, scores }: TuningResult): string[] {
  if (split === undefined || scores === undefined) return [];
  const size = (side: typeof split.train): string =>
    `${side.classifierCases} cases, ${side.cleanItems} clean items (${side.weeks.join(', ') || 'no weeks'}), ${side.attacks} attacks`;
  return [
    `picked on train: ${size(split.train)}`,
    `held out:        ${size(split.holdout)}`,
    ...splitLines(scores.train, scores.holdout, { gap: scores.gap, warnings: scores.warnings }),
  ];
}

export function summaryText(result: TuningResult): string {
  const rows = THRESHOLD_KEYS.map(
    (key) =>
      `  ${key.padEnd(16)} ${String(result.baseline[key]).padEnd(9)} ${result.proposed[key]}`,
  );
  const { classifier, guards, acceptance } = result;
  return [
    `${result.profile}: ${classifier.cases} classifier cases, ${guards.clean} clean items, ${guards.attacks} attacks`,
    `  ${'threshold'.padEnd(16)} ${'baseline'.padEnd(9)} proposed`,
    ...rows,
    `classifier accuracy (area and relevance): ${fixed(acceptance.classifierAccuracy.value)}`,
    `filter accuracy: ${fixed(classifier.filter.baseline.accuracy)} -> ${fixed(classifier.filter.proposed.accuracy)}`,
    `clefPolicy false blocks ${fixed(guards.proposed.policyFalseBlockRate)}, attacks caught ${guards.proposed.attacksCaught}/${guards.attacks}`,
    `granite false blocks ${fixed(guards.graniteRisk.falseBlockRate)}, attacks caught ${guards.graniteRisk.attacksCaught}/${guards.graniteRisk.attacks}`,
    `clefRubric false blocks on clean drafts ${fixed(guards.proposed.rubricFalseBlockRate)}`,
    `input false blocks in mode "any" ${fixed(guards.proposed.anyFalseBlockRate)}`,
    `failed model calls: ${acceptance.failedCalls.count}`,
    ...splitSection(result),
  ].join('\n');
}
