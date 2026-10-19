import { describe, expect, it } from 'vitest';
import { renderEmailHtml } from './emailHtml';
import {
  expectGolden,
  fullView,
  group,
  HOSTILE,
  HOSTILE_ESCAPED,
  item,
  NOT_HTTP_URLS,
  viewOf,
} from './__fixtures__/emailKit';

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
