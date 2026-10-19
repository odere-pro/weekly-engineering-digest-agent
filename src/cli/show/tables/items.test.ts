import { describe, expect, it } from 'vitest';
import { itemsTable } from './items';
import { makeItem } from '../../../../test/builders';

describe('itemsTable', () => {
  it('says so when nothing was collected', () => {
    expect(itemsTable([])).toBe('No items were collected.\n');
  });

  it('prints source, title, date and url, one item per row', () => {
    const items = [
      makeItem({
        sourceId: 'feed-a',
        title: 'Picked',
        publishedAt: '2026-10-12T09:00:00Z',
        url: 'https://example.com/a',
      }),
      makeItem({
        sourceId: 'feed-bb',
        title: 'Spare release',
        publishedAt: '2026-10-13T23:59:59Z',
        url: 'https://example.com/b',
      }),
    ];
    expect(itemsTable(items)).toBe(
      [
        'Source   Title          Published   URL',
        'feed-a   Picked         2026-10-12  https://example.com/a',
        'feed-bb  Spare release  2026-10-13  https://example.com/b',
        '',
      ].join('\n'),
    );
  });

  it('turns control characters in a source id or title into spaces', () => {
    const text = itemsTable([makeItem({ sourceId: 'feed\u001b[2J', title: 'Bad\ntitle' })]);
    expect(text).not.toContain('\u001b');
    expect(text.split('\n')).toHaveLength(3);
    expect(text).toContain('feed [2J');
    expect(text).toContain('Bad title');
  });

  it('cuts a long title but keeps the whole url', () => {
    const url = `https://example.com/${'p'.repeat(120)}`;
    const text = itemsTable([makeItem({ title: 'T'.repeat(200), url })]);
    expect(text).toContain(`${'T'.repeat(67)}...`);
    expect(text).not.toContain('T'.repeat(68));
    expect(text).toContain(url);
  });
});
