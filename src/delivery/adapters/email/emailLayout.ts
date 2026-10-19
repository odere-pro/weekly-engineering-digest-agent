import type { DigestView, DigestViewGroup } from '../../../render/digestView';

export type Urgency = DigestViewGroup['urgency'];

export interface Column {
  header: string;
  /** Width in percent. */
  width: number;
}

interface UrgencyLayout {
  emoji: string;
  /** Release and What changed. */
  columns: readonly Column[];
  /** The third column; good-to-know has none. */
  action?: Column;
}

const ACT_NOW_ACTION: Column = { header: 'What to do', width: 30 };
const WORTH_A_LOOK_ACTION: Column = { header: 'Relevant if you', width: 30 };

/** What each urgency looks like in both parts of the mail: its emoji and its table columns. */
export const LAYOUT: Readonly<Record<Urgency, UrgencyLayout>> = {
  'act-now': {
    emoji: '🔴',
    columns: [
      { header: 'Release', width: 28 },
      { header: 'What changed', width: 42 },
    ],
    action: ACT_NOW_ACTION,
  },
  'worth-a-look': {
    emoji: '🟡',
    columns: [
      { header: 'Release', width: 28 },
      { header: 'What changed', width: 42 },
    ],
    action: WORTH_A_LOOK_ACTION,
  },
  'good-to-know': {
    emoji: '⚪',
    columns: [
      { header: 'Release', width: 35 },
      { header: 'What changed', width: 65 },
    ],
  },
};

/** Shown in the action cell when an item has no action. */
export const NO_ACTION = '—';

/** The columns of a group's table, in order. */
export function columnsOf(urgency: Urgency): readonly Column[] {
  const { columns, action } = LAYOUT[urgency];
  return action ? [...columns, action] : columns;
}

/** The groups that have at least one item, in the view's order. */
export function groupsWithItems(view: DigestView): DigestViewGroup[] {
  return view.groups.filter((group) => group.items.length > 0);
}
