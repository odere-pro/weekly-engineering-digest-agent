import { describe, expect, it } from 'vitest';
import { renderEmailText } from './emailText';
import {
  expectGolden,
  fullView,
  group,
  item,
  NOT_HTTP_URLS,
  viewOf,
} from './__fixtures__/emailKit';

describe('renderEmailText', () => {
  it('matches the golden text for a full digest', () => {
    expectGolden(renderEmailText(fullView), 'full.txt.golden');
  });

  it('writes one bullet per item with title, what changed, the action line and the URL', () => {
    const text = renderEmailText(
      viewOf([
        group('act-now', [item({ title: 'A', action: 'Do it.' })], 'Act now'),
        group('worth-a-look', [item({ title: 'B', action: 'run B.' })], 'Worth a look'),
      ]),
    );

    expect(text).toContain('- A\n  What changed: Something changed.\n  What to do: Do it.\n');
    expect(text).toContain('- B\n  What changed: Something changed.\n  Relevant if you: run B.\n');
    expect(text.match(/^- /gm)).toHaveLength(2);
    expect(text.match(/^ {2}https:\/\/example\.com\/release$/gm)).toHaveLength(2);
  });

  it('leaves the action line out when an item has none, and for good-to-know items', () => {
    const text = renderEmailText(
      viewOf([
        group('act-now', [item({ title: 'A' })]),
        group('good-to-know', [item({ title: 'G', action: 'ignored' })]),
      ]),
    );

    expect(text).not.toContain('What to do');
    expect(text).not.toContain('Relevant if you');
    expect(text).not.toContain('ignored');
  });

  it('uses the label from the view for each group heading', () => {
    const text = renderEmailText(
      viewOf([
        group('act-now', [item()], 'Act now'),
        group('good-to-know', [item()], 'Good to know'),
      ]),
    );

    expect(text).toContain('🔴 Act now\n');
    expect(text).toContain('⚪ Good to know\n');
  });

  it('writes only the footer after the groups, and nothing when there is none', () => {
    const withFooter = renderEmailText(
      viewOf([group('act-now', [item()])], { footer: 'Guard off.' }),
    );
    const without = renderEmailText(viewOf([group('act-now', [item()])]));

    expect(withFooter.endsWith('\n\nGuard off.\n')).toBe(true);
    expect(without.endsWith('release\n')).toBe(true);
    expect(without).not.toContain('Guard off.');
  });

  it('skips a group without items, and renders only title and headline without groups', () => {
    const empty = renderEmailText(viewOf([group('act-now', [])]));

    expect(empty).toBe('Week 2026-W42: 1 release, nothing needs action\n\nA quiet week.\n');
    expect(renderEmailText(viewOf([]))).toBe(empty);
  });

  it('keeps a multi-line model string on one line so it cannot fake a bullet or a URL', () => {
    const text = renderEmailText(
      viewOf([
        group('act-now', [
          item({
            title: 'Real\n- Fake title',
            whatChanged: 'Line one\r\n  https://evil.test/\u0000\u0007end',
            action: 'Do\tit',
          }),
        ]),
      ]),
    );

    expect(text).toContain('- Real - Fake title\n');
    expect(text).toContain('What changed: Line one https://evil.test/ end\n');
    expect(text).toContain('What to do: Do it\n');
    expect(text.match(/^- /gm)).toHaveLength(1);
    expect(text.match(/^ {2}https:/gm)).toHaveLength(1);
  });

  it.each(NOT_HTTP_URLS)('prints no URL line for %j', (url) => {
    const text = renderEmailText(viewOf([group('act-now', [item({ title: 'T', url })])]));

    expect(text).toBe(
      'Week 2026-W42: 1 release, nothing needs action\n\nA quiet week.\n\n🔴 Label\n\n' +
        '- T\n  What changed: Something changed.\n',
    );
  });

  it('prints an http or https URL in its normalised form', () => {
    const text = renderEmailText(
      viewOf([
        group('act-now', [
          item({ title: 'Plain', url: 'http://example.com/ok' }),
          item({ title: 'Upper', url: 'HTTPS://Example.com/Path?q=1' }),
          item({ title: 'Bare', url: 'https://example.com' }),
        ]),
      ]),
    );

    expect(text).toContain('  http://example.com/ok\n');
    expect(text).toContain('  https://example.com/Path?q=1\n');
    expect(text).toContain('  https://example.com/\n');
  });

  it('keeps a hostile title, headline, label and footer on one line each', () => {
    const fake = 'x\n\n🔴 Act now\n- Fake bullet\n  https://evil.test/';
    const text = renderEmailText(
      viewOf([group('good-to-know', [item({ title: fake })], fake)], {
        title: fake,
        headline: fake,
        footer: fake,
      }),
    );

    const flat = 'x 🔴 Act now - Fake bullet https://evil.test/';
    const bullet = `- ${flat}\n  What changed: Something changed.\n  https://example.com/release`;
    expect(text).toBe(`${[flat, flat, `⚪ ${flat}`, bullet, flat].join('\n\n')}\n`);
  });

  it('removes bidi override characters and falls back to a placeholder for an empty title', () => {
    const text = renderEmailText(
      viewOf([group('act-now', [item({ title: 'A‮evil⁦x' }), item({ title: ' \n ' })])]),
    );

    expect(text).toContain('- A evil x\n');
    expect(text).toContain('- (untitled)\n');
  });

  it('leaves out a footer that is only whitespace', () => {
    const text = renderEmailText(viewOf([group('act-now', [item()])], { footer: ' \n ' }));

    expect(text.endsWith('release\n')).toBe(true);
  });

  it('does not escape HTML in the plain-text part', () => {
    const text = renderEmailText(viewOf([group('act-now', [item({ title: 'A & B <c>' })])]));

    expect(text).toContain('- A & B <c>\n');
  });
});
