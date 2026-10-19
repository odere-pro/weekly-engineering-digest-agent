import { describe, expect, it } from 'vitest';
import { columnsOf, groupsWithItems, LAYOUT, NO_ACTION } from './emailLayout';
import { group, item, viewOf } from './__fixtures__/emailKit';

describe('LAYOUT', () => {
  it('gives each urgency its own emoji', () => {
    expect(LAYOUT['act-now'].emoji).toBe('🔴');
    expect(LAYOUT['worth-a-look'].emoji).toBe('🟡');
    expect(LAYOUT['good-to-know'].emoji).toBe('⚪');
  });

  it('has a third column for act-now and worth-a-look, and none for good-to-know', () => {
    expect(LAYOUT['act-now'].action?.header).toBe('What to do');
    expect(LAYOUT['worth-a-look'].action?.header).toBe('Relevant if you');
    expect(LAYOUT['good-to-know'].action).toBeUndefined();
  });

  it('marks a missing action with a dash', () => {
    expect(NO_ACTION).toBe('—');
  });
});

describe('columnsOf', () => {
  it('lists Release, What changed and the action column for act-now and worth-a-look', () => {
    expect(columnsOf('act-now').map((column) => column.header)).toEqual([
      'Release',
      'What changed',
      'What to do',
    ]);
    expect(columnsOf('worth-a-look').map((column) => column.header)).toEqual([
      'Release',
      'What changed',
      'Relevant if you',
    ]);
  });

  it('lists two columns for good-to-know', () => {
    expect(columnsOf('good-to-know').map((column) => column.header)).toEqual([
      'Release',
      'What changed',
    ]);
  });

  it.each(['act-now', 'worth-a-look', 'good-to-know'] as const)(
    'makes the %s widths add up to 100 percent',
    (urgency) => {
      const total = columnsOf(urgency).reduce((sum, column) => sum + column.width, 0);

      expect(total).toBe(100);
    },
  );

  it('adds the action column to a copy, leaving the two base columns of the layout alone', () => {
    const columns = columnsOf('act-now');

    expect(columns).not.toBe(LAYOUT['act-now'].columns);
    expect(columns).toHaveLength(3);
    expect(LAYOUT['act-now'].columns).toHaveLength(2);
  });
});

describe('groupsWithItems', () => {
  it('drops groups without items and keeps the order of the rest', () => {
    const view = viewOf([
      group('act-now', [item({ title: 'A' })], 'One'),
      group('worth-a-look', [], 'Two'),
      group('good-to-know', [item({ title: 'G' })], 'Three'),
    ]);

    expect(groupsWithItems(view).map((entry) => entry.label)).toEqual(['One', 'Three']);
  });

  it('returns nothing for a view whose only group is empty, and leaves the view as it was', () => {
    const view = viewOf([group('act-now', [])]);

    expect(groupsWithItems(view)).toEqual([]);
    expect(view.groups).toHaveLength(1);
  });
});
