import type { Draft, Item } from '../domain/schemas';
import type { GuardCheckId, GuardVerdict } from './guardVerdict';

export interface GuardCallOptions {
  signal?: AbortSignal;
}

/** Checks one collected item before any other model sees it. */
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
