import { formatCheck } from '../../../src/checks/formatCheck';
import type { CheckResult } from '../../../src/checks/types';
import type { Digest } from '../../../src/domain/schemas';
import { checkedSamples, type DigestSample } from './digestSample';
import { parseDigestMarkdown } from './parseDigest';
import { share } from '../measurement/numbers';
import { withByWeek, type Measurement } from '../measurement/measurement';
import { weekDetail } from '../measurement/weekDetail';

/**
 * The layout prints no intro, and no why-it-matters line, so a digest read back from it has none
 * (see parseDigestMarkdown). The format check cannot ask for what the file does not show.
 */
const NOT_PRINTED_PROBLEM = /^Missing (?:intro|why-it-matters in item \d+)$/;

function printedFormatCheck(digest: Digest, markdown: string): CheckResult {
  const problems = formatCheck(digest, markdown).problems.filter(
    (problem) => !NOT_PRINTED_PROBLEM.test(problem),
  );
  return { ok: problems.length === 0, problems };
}

/** The format check passes on the digest. A week without a digest fails it. */
export function formatCompliance(samples: readonly DigestSample[]): Measurement {
  const checked = checkedSamples(samples, ({ weekId, markdown, items }) =>
    weekDetail(printedFormatCheck(parseDigestMarkdown(markdown, weekId, items), markdown)),
  );
  const valid = checked.filter(({ detail }) => detail.status === 'ok');
  return withByWeek(share(valid.length, checked.length), checked);
}
