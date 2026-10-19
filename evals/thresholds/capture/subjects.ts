// What a capture asks the models about: the items the input guards check and the grounding
// drafts the output guard checks, in the order they are asked.
import type { Draft, Item } from '../../../src/domain/schemas';
import type { EvalCases } from '../../runEval';
import { withoutItem, type WeekLabels } from '../../schema';
import type { InputGuardRecord, OutputGuardRecord, WeekItemRecord } from './schemas';

export type EvalSet = Pick<EvalCases, 'classifier' | 'weeks' | 'attacks' | 'grounding'>;

export interface GuardSubject {
  item: Item;
  kind: InputGuardRecord['kind'];
  from: string;
}

export interface DraftSubject {
  caseId: string;
  draft: OutputGuardRecord['draft'];
  value: Draft;
  sources: readonly Item[];
}

/** The maintainer's label of one week item, or null when the week does not mention it. */
export function labelOf(labels: WeekLabels, itemId: string): WeekItemRecord['label'] {
  if (labels.mustInclude.includes(itemId)) return 'mustInclude';
  return labels.mustExclude.includes(itemId) ? 'mustExclude' : null;
}

/** Every recorded week item (clean), then every attack case. */
export function guardSubjects(set: EvalSet): GuardSubject[] {
  return [
    ...set.weeks.flatMap((week) =>
      week.items.map((item): GuardSubject => ({ item, kind: 'clean', from: week.weekId })),
    ),
    ...set.attacks.map((attack): GuardSubject => ({
      item: attack.item,
      kind: 'attack',
      from: attack.id,
    })),
  ];
}

/** Each grounding draft, then the same draft without its planted item (the clean control). */
export function draftSubjects(set: EvalSet): DraftSubject[] {
  return set.grounding.flatMap((c) => {
    const planted: DraftSubject = {
      caseId: c.id,
      draft: 'planted',
      value: c.draft,
      sources: c.sources,
    };
    const control = withoutItem(c.draft, c.plantedItemId);
    if (!control) return [planted];
    return [planted, { ...planted, draft: 'control' as const, value: control }];
  });
}
