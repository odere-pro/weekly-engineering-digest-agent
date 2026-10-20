import type { Draft, Item } from '../domain/schemas';
import type { GuardCheckId, GuardVerdict } from './guardVerdict';

export interface GuardCallOptions {
  signal?: AbortSignal;
}

/**
 * Checks one collected item. The rule guard checks every item before any model sees it; the
 * model guards check the items `process` picked, before any model that writes text sees them.
 */
export interface InputGuard {
  readonly id: GuardCheckId;
  checkItem(item: Item, options?: GuardCallOptions): Promise<GuardVerdict>;
}

/** Checks one draft against the source items it cites. */
export interface OutputGuard {
  readonly id: GuardCheckId;
  checkDraft(
    draft: Draft,
    sources: readonly Item[],
    options?: GuardCallOptions,
  ): Promise<GuardVerdict>;
}
