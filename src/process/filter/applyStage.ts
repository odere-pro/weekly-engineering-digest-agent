import type { ScoredItem } from '../../classify/classification';
import type { DropReason, Dropped, Entry } from '../types';

/** One filter step: given the survivors so far, say which entries it drops. */
export interface Stage {
  readonly reason: DropReason;
  readonly drops: (survivors: readonly Entry[]) => (entry: Entry) => boolean;
}

export interface Partition {
  readonly kept: readonly Entry[];
  readonly dropped: readonly Dropped[];
}

export function drop(item: ScoredItem, reason: DropReason): Dropped {
  return { itemId: item.id, reason };
}

/** Runs one stage over the survivors: its drops leave `kept` and join `dropped` under its reason. */
export function applyStage(current: Partition, stage: Stage): Partition {
  const isDropped = stage.drops(current.kept);
  return {
    kept: current.kept.filter((entry) => !isDropped(entry)),
    dropped: [
      ...current.dropped,
      ...current.kept.filter(isDropped).map(({ item }) => drop(item, stage.reason)),
    ],
  };
}
