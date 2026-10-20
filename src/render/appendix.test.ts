import { describe, expect, it } from 'vitest';
import { makeScoredItem } from '../../test/builders';
import { buildAppendix, renderAppendix } from './appendix';

const scored = (title: string, area: string, summary = 'It ships. It also fixes a bug.') =>
  makeScoredItem({ title, summary, url: `https://example.test/${title}` }, { area });

describe('buildAppendix', () => {
  it('is undefined for no items', () => {
    expect(buildAppendix([])).toBeUndefined();
  });

  it('groups by area in first-seen order and keeps the rank order inside a group', () => {
    const appendix = buildAppendix([
      scored('a', 'Security'),
      scored('b', 'Models'),
      scored('c', 'Security'),
    ]);

    expect(appendix?.title).toBe('Everything this week');
    expect(appendix?.groups.map((g) => [g.area, g.items.map((i) => i.title)])).toEqual([
      ['Security', ['a', 'c']],
      ['Models', ['b']],
    ]);
  });

  it('files an item with no usable area under Releases', () => {
    expect(buildAppendix([scored('a', ' | ')])?.groups[0]?.area).toBe('Releases');
  });

  it('takes title and line from the item text, free of links', () => {
    const appendix = buildAppendix([
      scored('Runner https://evil.example', 'Models', 'See www.evil.test now. Fine.'),
    ]);

    expect(appendix?.groups[0]?.items[0]).toMatchObject({
      title: 'Runner',
      line: 'See now. Fine.',
    });
  });
});

describe('renderAppendix', () => {
  it('writes a heading, an area heading and a linked bullet per release', () => {
    const appendix = buildAppendix([scored('a', 'Security', 'One. Two.')]);

    expect(renderAppendix(appendix!)).toBe(
      '\n## Everything this week\n\n### Security\n\n- [a](https://example.test/a): One. Two.\n',
    );
  });

  it('shows the url when a title is blank', () => {
    const out = renderAppendix({
      title: 'Everything this week',
      groups: [{ area: 'A', items: [{ title: '', url: 'https://e.test/a', line: 'l' }] }],
    });

    expect(out).toContain('- [https://e.test/a](https://e.test/a): l');
  });

  it('escapes brackets, pipes and angle brackets like an item in the table', () => {
    const out = renderAppendix({
      title: 'Everything this week',
      groups: [
        {
          area: 'A<b>',
          items: [{ title: 'x]<y>|[', url: 'https://e.test/a|b', line: '<svg onload=1>' }],
        },
      ],
    });

    expect(out).toContain('### A\\<b\\>');
    expect(out).toContain('- [x\\]\\<y\\>\\|\\[](https://e.test/a\\|b): \\<svg onload=1\\>');
  });
});
