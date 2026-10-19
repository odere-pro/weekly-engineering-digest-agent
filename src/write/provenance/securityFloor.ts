import type { DigestItem } from '../../domain/schemas';
import type { ScoredItem } from '../../classify/classification';
import type { Logger } from '../../shared/telemetry';
import { loggedId } from './loggedId';

/**
 * The floor under urgency (W8-01): an item whose source names a CVE, a security advisory or a
 * vulnerability, or calls itself a security fix, patch, update or release, is never good-to-know,
 * whatever the model says. It reads the collected source and never the model's own text. A source
 * that only mentions the word ("vulnerability scanner") raises the item too: the floor errs toward
 * worth-a-look, and never goes above it.
 */
const SECURITY_SOURCE =
  /\bCVEs?\b|\bGHSA-|\bsecurity (?:advisor(?:y|ies)|fix(?:es)?|patch(?:es)?|updates?|releases?)\b|\bvulnerabilit(?:y|ies)\b/i;
/** The action of an item the floor raised when the writer gave it none. */
export const SECURITY_FLOOR_ACTION = 'Relevant if you use this project. Check its security notes.';

/**
 * Applies the security floor (W8-01): a good-to-know item whose source names a security issue
 * becomes worth-a-look, and says so in the log. It keeps the writer's action; with none, it gets
 * a fixed line, so the floor cannot make the draft fail the format check's "needs an action".
 */
export function raiseSecurityItems(
  items: readonly DigestItem[],
  sources: ReadonlyMap<string, ScoredItem>,
  logger: Logger,
): DigestItem[] {
  return items.map((item) => {
    const source = sources.get(item.itemId);
    if (item.urgency !== 'good-to-know' || source === undefined || !namesSecurityIssue(source)) {
      return item;
    }
    logger.info('Raised urgency: the source names a security issue', {
      itemId: loggedId(item.itemId),
      from: item.urgency,
      to: 'worth-a-look',
    });
    return { ...item, urgency: 'worth-a-look', action: item.action ?? SECURITY_FLOOR_ACTION };
  });
}

export function namesSecurityIssue(source: ScoredItem): boolean {
  return SECURITY_SOURCE.test(`${source.title}\n${source.summary}`);
}
