import type { Item } from '../../../src/domain/schemas';
import type { WeekDetail } from '../../schema';
import type { CheckedWeek } from '../measurement/measurement';
import { noDigest, uniqueLabels } from '../measurement/weekDetail';

/** One week's output and the items that were collected for it. */
export interface DigestSample {
  weekId: string;
  /** What names this replay in the per-week detail. Default: the week id. */
  label?: string;
  /** undefined when the run produced no digest (quiet, blocked or failed). */
  markdown: string | undefined;
  items: readonly Item[];
  /** Why there is no digest (`noDigestCause`); shown in the week's detail. */
  cause?: string;
}

/** Runs a check on every sample; a sample without a digest has nothing to check. */
export function checkedSamples(
  samples: readonly DigestSample[],
  check: (sample: DigestSample & { markdown: string }) => WeekDetail,
): CheckedWeek[] {
  const labels = uniqueLabels(samples.map((sample) => sample.label ?? sample.weekId));
  return samples.map((sample, index) => ({
    label: labels[index] ?? sample.weekId,
    detail:
      sample.markdown === undefined
        ? noDigest(sample.cause)
        : check({ ...sample, markdown: sample.markdown }),
  }));
}
