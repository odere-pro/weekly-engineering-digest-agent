import { describe, expect, it } from 'vitest';
import { STYLE } from './emailStyle';

const BACKGROUND = /(?:^|;)background-color:#[0-9a-f]{6};/;
const TEXT_COLOR = /(?:^|;)color:#[0-9a-f]{6};/;

describe('STYLE', () => {
  const entries = Object.entries(STYLE);

  it.each(entries)(
    '%s is a declaration list that cannot leave its style attribute',
    (_name, css) => {
      expect(css).toMatch(/^(?:[a-z-]+:[^;"<>]+;)+$/);
      expect(css).not.toMatch(/url\(|@import|expression\(/i);
    },
  );

  it.each([
    'body',
    'outer',
    'outerCell',
    'card',
    'cardCell',
    'table',
    'th',
    'td',
    'mutedTd',
  ] as const)(
    'sets its own background on %s, so a client that darkens the mail cannot pair light text with a light page',
    (name) => {
      expect(STYLE[name]).toMatch(BACKGROUND);
    },
  );

  it.each([
    'body',
    'outerCell',
    'cardCell',
    'title',
    'headline',
    'group',
    'area',
    'list',
    'th',
    'td',
    'mutedTd',
    'link',
    'footer',
  ] as const)('sets its own text colour on %s', (name) => {
    expect(STYLE[name]).toMatch(TEXT_COLOR);
  });

  it('sets a system font stack on the body, with no remote font', () => {
    expect(STYLE.body).toContain('font-family:-apple-system,BlinkMacSystemFont,');
    expect(STYLE.body).not.toMatch(/https?:/);
  });

  it('underlines a link, so it does not rely on colour alone', () => {
    expect(STYLE.link).toContain('text-decoration:underline;');
  });
});
