import { readFileSync, writeFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { renderEmailHtml, renderEmailText } from './emailRender';
import type { DigestView, DigestViewGroup, DigestViewItem } from '../Delivery';

const FIXTURES = new URL('./__fixtures__/email/', import.meta.url);

function fixture(name: string): string {
  return readFileSync(new URL(name, FIXTURES), 'utf8');
}

/** Compares with a golden file; UPDATE_GOLDEN=1 rewrites it so a layout change is one command. */
function expectGolden(actual: string, name: string): void {
  if (process.env['UPDATE_GOLDEN'] === '1') writeFileSync(new URL(name, FIXTURES), actual);
  expect(actual).toBe(fixture(name));
}

const fullView = JSON.parse(fixture('full.view.json')) as DigestView;

function item(overrides: Partial<DigestViewItem> = {}): DigestViewItem {
  return {
    title: 'Release',
    url: 'https://example.com/release',
    whatChanged: 'Something changed.',
    ...overrides,
  };
}

function group(
  urgency: DigestViewGroup['urgency'],
  items: DigestViewItem[],
  label = 'Label',
): DigestViewGroup {
  return { urgency, label, items };
}

function viewOf(groups: DigestViewGroup[], overrides: Partial<DigestView> = {}): DigestView {
  return {
    weekId: '2026-W42',
    title: 'Week 2026-W42: 1 release, nothing needs action',
    headline: 'A quiet week.',
    groups,
    ...overrides,
  };
}

/** URLs that must never become a link or a printed URL line. */
const NOT_HTTP_URLS = [
  'javascript:alert(1)',
  'JaVaScRiPt:alert(1)',
  ' javascript:alert(1)',
  'java\tscript:alert(1)',
  '\u0001javascript:alert(1)',
  'data:text/html;base64,PHNjcmlwdD4=',
  'vbscript:msgbox(1)',
  'ftp://example.com/file',
  '/releases',
  '//example.com/releases',
  'https://',
  'https:foo',
  'https:/foo',
  'http:example.com',
  'https://example.com/a b',
  'https://example.com/\n',
  'https://exa​mple.com/',
  'https://example.com/‮abc',
  'https://github.com@evil.test/x',
  'https://user:pw@example.com/',
  '',
];

const HOSTILE = `<script>alert("x")</script> & 'q' "d"`;
const HOSTILE_ESCAPED =
  '&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt; &amp; &#39;q&#39; &quot;d&quot;';

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

describe('renderEmailHtml', () => {
  it('matches the golden HTML for a full digest', () => {
    expectGolden(renderEmailHtml(fullView), 'full.html.golden');
  });

  it('is a complete HTML document that declares its charset, language and colour schemes', () => {
    const html = renderEmailHtml(fullView);

    expect(html.startsWith('<!doctype html>\n<html lang="en">')).toBe(true);
    expect(html).toContain('<meta charset="utf-8">');
    expect(html).toContain('<meta name="viewport" content="width=device-width, initial-scale=1">');
    expect(html).toContain('<meta name="color-scheme" content="light dark">');
    expect(html).toContain('<title>Week 2026-W42: 5 releases, 1 needs action</title>');
    expect(html.trimEnd().endsWith('</html>')).toBe(true);
  });

  it('shows the title, then the headline in italics, then one table per group', () => {
    const html = renderEmailHtml(fullView);

    const h1 = html.indexOf('<h1');
    const headline = html.indexOf(
      '<em>One Ollama fix needs action this week; the rest can wait.</em>',
    );
    const firstTable = html.indexOf('<table', html.indexOf('<h2'));
    expect(h1).toBeGreaterThan(-1);
    expect(headline).toBeGreaterThan(h1);
    expect(firstTable).toBeGreaterThan(headline);
    expect(html.match(/<h2/g)).toHaveLength(3);
    expect(html.match(/<th /g)).toHaveLength(3 + 3 + 2);
  });

  it('names the columns of each urgency', () => {
    const html = renderEmailHtml(fullView);
    const headers = [...html.matchAll(/<th [^>]*>([^<]*)<\/th>/g)].map((match) => match[1]);

    expect(headers).toEqual([
      'Release',
      'What changed',
      'What to do',
      'Release',
      'What changed',
      'Relevant if you',
      'Release',
      'What changed',
    ]);
  });

  it('puts the emoji and the label from the view in each group heading', () => {
    const html = renderEmailHtml(fullView);
    const headings = [...html.matchAll(/<h2 [^>]*>([^<]*)<\/h2>/g)].map((match) => match[1]);

    expect(headings).toEqual(['🔴 Act now', '🟡 Worth a look', '⚪ Good to know']);
  });

  it('links the release title to its URL with rel="noopener" and nothing else', () => {
    const html = renderEmailHtml(fullView);
    const anchors = [...html.matchAll(/<a [^>]*>/g)].map((match) => match[0]);

    expect(anchors).toHaveLength(5);
    for (const anchor of anchors) expect(anchor).toContain(' rel="noopener"');
    const hrefs = anchors.map((anchor) => /href="([^"]*)"/.exec(anchor)?.[1]);
    expect(hrefs).toEqual(
      fullView.groups.flatMap((entry) => entry.items.map((entry2) => entry2.url)),
    );
    expect(html).toContain('>Ollama v0.13.0</a>');
  });

  it('escapes every model string', () => {
    const html = renderEmailHtml(
      viewOf(
        [
          group(
            'act-now',
            [item({ title: HOSTILE, whatChanged: HOSTILE, action: HOSTILE })],
            HOSTILE,
          ),
        ],
        {
          title: HOSTILE,
          headline: HOSTILE,
          footer: HOSTILE,
        },
      ),
    );

    expect(html).not.toContain('<script');
    expect(html).not.toContain('alert("x")');
    expect(html.split(HOSTILE_ESCAPED).length - 1).toBe(8);
  });

  it('collapses whitespace and control characters inside a model string', () => {
    const html = renderEmailHtml(
      viewOf([group('act-now', [item({ whatChanged: 'one\n\ntwo\u0000three' })])]),
    );

    expect(html).toContain('>one two three</td>');
  });

  it('renders a javascript: title as escaped text and links it only to the real URL', () => {
    const html = renderEmailHtml(
      viewOf([
        group('act-now', [item({ title: 'javascript:alert(1)', url: 'https://example.com/safe' })]),
      ]),
    );

    expect(html).toContain('<a href="https://example.com/safe" rel="noopener"');
    expect(html).toContain('>javascript:alert(1)</a>');
  });

  it.each(NOT_HTTP_URLS)('renders the title as plain text, with no link, for %j', (url) => {
    const html = renderEmailHtml(viewOf([group('act-now', [item({ title: 'Plain title', url })])]));

    expect(html).toContain('>Plain title</td>');
    expect(html).not.toContain('<a ');
    expect(html).not.toContain('href');
  });

  it('links an http or https URL in its normalised form', () => {
    const html = renderEmailHtml(
      viewOf([
        group('act-now', [
          item({ url: 'HTTPS://Example.com/Path?q=1' }),
          item({ url: 'https://example.com' }),
        ]),
      ]),
    );

    expect(html).toContain('href="https://example.com/Path?q=1"');
    expect(html).toContain('href="https://example.com/"');
  });

  it('keeps a hostile URL inside its href attribute', () => {
    const html = renderEmailHtml(
      viewOf([
        group('act-now', [item({ url: 'https://example.com/a?x="><script>alert(1)</script>' })]),
      ]),
    );

    expect(html).not.toContain('<script');
    expect(html).toContain(
      'href="https://example.com/a?x=%22%3E%3Cscript%3Ealert(1)%3C/script%3E"',
    );
  });

  it('escapes a single quote in a URL path', () => {
    const html = renderEmailHtml(
      viewOf([group('act-now', [item({ url: "https://example.com/it's" })])]),
    );

    expect(html).toContain('href="https://example.com/it&#39;s"');
  });

  it('shows an empty or bidi-laden title as a placeholder or with the overrides removed', () => {
    const html = renderEmailHtml(
      viewOf([group('act-now', [item({ title: 'A‮evil' }), item({ title: ' \n ' })])]),
    );

    expect(html).toContain('>A evil</a>');
    expect(html).toContain('>(untitled)</a>');
  });

  it('escapes the ampersand in a URL query', () => {
    const html = renderEmailHtml(
      viewOf([group('act-now', [item({ url: 'https://example.com/?a=1&b=2' })])]),
    );

    expect(html).toContain('href="https://example.com/?a=1&amp;b=2"');
  });

  it('shows a dash where an act-now or worth-a-look item has no action', () => {
    const html = renderEmailHtml(viewOf([group('act-now', [item()])]));

    expect(html).toContain('>—</td>');
  });

  it('has no third column for good-to-know, even when the item carries an action', () => {
    const html = renderEmailHtml(
      viewOf([group('good-to-know', [item({ action: 'secret-action' })])]),
    );

    expect(html).not.toContain('secret-action');
    expect(html.match(/<th /g)).toHaveLength(2);
  });

  it('renders the footer when present and leaves it out otherwise', () => {
    const withFooter = renderEmailHtml(
      viewOf([group('act-now', [item()])], { footer: 'Guards off.' }),
    );
    const without = renderEmailHtml(viewOf([group('act-now', [item()])]));

    expect(withFooter).toContain('>Guards off.</p>');
    expect(without).not.toContain('Guards off.');
  });

  it('skips a group without items and renders no table without groups', () => {
    const html = renderEmailHtml(viewOf([group('act-now', [])]));

    expect(html).not.toContain('<h2');
    expect(html.match(/<th /g)).toBeNull();
    expect(html).toContain('A quiet week.');
  });

  it('carries no script, style block, form, remote asset or event handler', () => {
    const html = renderEmailHtml(fullView);

    expect(html).not.toMatch(/<script|<style|<link|<img|<iframe|<form|<object|<embed|<svg/i);
    expect(html).not.toMatch(/\ssrc=|@import|url\(|\son[a-z]+=/i);
    expect(html).not.toContain('<base');
    const remote = [...html.matchAll(/https?:\/\/[^"\s<)]+/g)].map((match) => match[0]);
    const links = fullView.groups.flatMap((entry) => entry.items.map((entry2) => entry2.url));
    expect(remote.every((url) => links.includes(url))).toBe(true);
  });

  it('sets a background and a text colour on the page, the card and every cell, for dark mode', () => {
    const html = renderEmailHtml(fullView);
    const cells = [...html.matchAll(/<(?:td|th) [^>]*>/g)].map((match) => match[0]);

    expect(html).toMatch(/<body style="[^"]*background-color:#f4f5f7/);
    expect(html).toContain('background-color:#ffffff');
    expect(cells.length).toBeGreaterThan(10);
    for (const cell of cells) {
      expect(cell).toContain('style="');
      expect(cell).toMatch(/[;"]color:#[0-9a-f]{6}/);
    }
  });
});
