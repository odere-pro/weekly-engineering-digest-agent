import { linkCheck } from '../../../src/checks/linkCheck';
import { checkedSamples, type DigestSample } from './digestSample';
import { parseDigestMarkdown } from './parseDigest';
import { share } from '../measurement/numbers';
import { withByWeek, type Measurement } from '../measurement/measurement';
import { weekDetail } from '../measurement/weekDetail';

/**
 * Every produced digest links only to collected items. Weeks without a digest have no links, so
 * they are shown in `byWeek` and left out of the value.
 */
export function linkValidity(samples: readonly DigestSample[]): Measurement {
  const checked = checkedSamples(samples, ({ weekId, markdown, items }) =>
    weekDetail(linkCheck(parseDigestMarkdown(markdown, weekId, items), markdown, items)),
  );
  const produced = checked.filter(({ detail }) => detail.status !== 'no-digest');
  const valid = produced.filter(({ detail }) => detail.status === 'ok');
  return withByWeek(share(valid.length, produced.length), checked);
}
