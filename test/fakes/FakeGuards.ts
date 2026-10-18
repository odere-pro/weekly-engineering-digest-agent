import type { Draft, GuardCheckId, GuardVerdict, Item } from '../../src/domain/schemas';
import type { InputGuard, OutputGuard } from '../../src/guards/Guard';

/** Flags the items for which `flag` returns true. */
export class FakeInputGuard implements InputGuard {
  readonly calls: Item[] = [];
  constructor(
    readonly id: GuardCheckId,
    private readonly flag: (item: Item) => boolean = () => false,
  ) {}

  checkItem(item: Item): Promise<GuardVerdict> {
    this.calls.push(item);
    return Promise.resolve({ check: this.id, flagged: this.flag(item) });
  }
}

/** Flags the drafts for which `flag` returns true. */
export class FakeOutputGuard implements OutputGuard {
  readonly calls: Draft[] = [];
  constructor(
    readonly id: GuardCheckId,
    private readonly flag: (draft: Draft) => boolean = () => false,
  ) {}

  checkDraft(draft: Draft): Promise<GuardVerdict> {
    this.calls.push(draft);
    return Promise.resolve({ check: this.id, flagged: this.flag(draft) });
  }
}
