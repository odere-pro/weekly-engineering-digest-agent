import type { Draft } from '../../domain/schemas';
import { prepareWithCount } from '../links/prepareDraft';
import { codeCheck } from './codeCheck';
import type { CheckContext, CodeChecked } from './types';

/**
 * One writer's draft, made ready and checked: the deterministic fixes first (`prepareDraft`),
 * then the link and format checks on what the digest will read.
 */
export function checkDraft(draft: Draft, context: CheckContext): CodeChecked {
  const { collected, disabledGuards, topN, logger } = context;
  const collectedUrls = collected.map((item) => item.url);
  const { draft: prepared, repairedLinks } = prepareWithCount(draft, topN, collectedUrls);
  if (repairedLinks > 0) {
    logger.info('Added https:// to links the writer left bare', {
      writer: draft.writer,
      links: repairedLinks,
    });
  }
  return codeCheck(prepared, collected, { disabledGuards });
}
