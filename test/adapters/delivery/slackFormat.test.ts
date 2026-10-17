import { describe, expect, it } from 'vitest';
import { escapeSlack, toSlackMrkdwn } from '../../../src/adapters/delivery/slackFormat.js';

describe('escapeSlack', () => {
  it('escapes &, < and > and leaves other text alone', () => {
    expect(escapeSlack('a & b <!channel> c > d')).toBe('a &amp; b &lt;!channel&gt; c &gt; d');
    expect(escapeSlack('plain *text* with "quotes"')).toBe('plain *text* with "quotes"');
  });

  it('escapes an & first, so an entity-like input is not read back as a different character', () => {
    expect(escapeSlack('&lt;')).toBe('&amp;lt;');
  });
});

describe('toSlackMrkdwn', () => {
  it('turns [text](url) into <url|text>', () => {
    expect(toSlackMrkdwn('See [Ollama 0.9](https://example.com/a) now')).toBe(
      'See <https://example.com/a|Ollama 0.9> now',
    );
  });

  it('keeps & in a link url escaped the way Slack expects', () => {
    expect(toSlackMrkdwn('[x](https://example.com/a?b=1&c=2)')).toBe(
      '<https://example.com/a?b=1&amp;c=2|x>',
    );
  });

  it('turns **bold** into *bold*', () => {
    expect(toSlackMrkdwn('This is **big** news and **more**')).toBe(
      'This is *big* news and *more*',
    );
  });

  it('turns headings of any level into a bold line', () => {
    expect(toSlackMrkdwn('# Title\n\n## Section\n\n### Deep')).toBe(
      '*Title*\n\n*Section*\n\n*Deep*',
    );
  });

  it('does not double the bold markers of a heading that already has bold text', () => {
    expect(toSlackMrkdwn('## The **big** one')).toBe('*The big one*');
  });

  it('keeps a link inside a heading clickable', () => {
    expect(toSlackMrkdwn('## [Release](https://example.com/r)')).toBe(
      '*<https://example.com/r|Release>*',
    );
  });

  it('escapes &, < and > so collected text cannot ping or inject links', () => {
    expect(toSlackMrkdwn('a < b & c > d <!channel> <@U123> <https://evil.example|click>')).toBe(
      'a &lt; b &amp; c &gt; d &lt;!channel&gt; &lt;@U123&gt; &lt;https://evil.example|click&gt;',
    );
  });

  it('leaves plain lines and list bullets alone', () => {
    expect(toSlackMrkdwn('- one\n- two\nplain')).toBe('- one\n- two\nplain');
  });

  it('does not treat a # inside a line as a heading', () => {
    expect(toSlackMrkdwn('issue #42 fixed')).toBe('issue #42 fixed');
  });

  it.each([
    ['[click](!channel)', '[click](!channel)'],
    ['[hi](!here)', '[hi](!here)'],
    ['[hi](@U123ABC)', '[hi](@U123ABC)'],
    ['[hi](#C123)', '[hi](#C123)'],
    ['[hi](!subteam^S123)', '[hi](!subteam^S123)'],
    ['[hi](javascript:alert(1))', '[hi](javascript:alert(1))'],
    ['[hi](/relative/path)', '[hi](/relative/path)'],
  ])('does not make a Slack link or token out of %s', (input, expected) => {
    const output = toSlackMrkdwn(input);

    expect(output).toBe(expected);
    expect(output).not.toMatch(/<[!@#]/);
  });

  it('leaves a link alone when its url holds the Slack separator |', () => {
    expect(toSlackMrkdwn('[t](https://example.com/a|b)')).toBe('[t](https://example.com/a|b)');
  });

  it('keeps one level of parentheses inside a url', () => {
    expect(toSlackMrkdwn('[Foo](https://en.wikipedia.org/wiki/Foo_(bar)) done')).toBe(
      '<https://en.wikipedia.org/wiki/Foo_(bar)|Foo> done',
    );
  });

  it('drops the image marker instead of leaving a stray !', () => {
    expect(toSlackMrkdwn('![logo](https://example.com/l.png)')).toBe(
      '<https://example.com/l.png|logo>',
    );
  });

  it('does not join a link label across lines', () => {
    expect(toSlackMrkdwn('[a\nb](https://example.com)')).toBe('[a\nb](https://example.com)');
  });

  it('keeps * inside a heading link url intact', () => {
    expect(toSlackMrkdwn('## [a](https://example.com/*b*)')).toBe('*<https://example.com/*b*|a>*');
  });

  it('ignores a heading marker with no title', () => {
    expect(toSlackMrkdwn('#   ')).toBe('#   ');
  });

  it('handles Windows line endings', () => {
    expect(toSlackMrkdwn('# Title\r\n\r\nbody **x**\r\n')).toBe('*Title*\n\nbody *x*\n');
  });

  it.each([
    ['unclosed brackets', '['.repeat(100_000)],
    ['unclosed links', '[a]('.repeat(25_000)],
    ['a heading with a long run of spaces', `# a${' '.repeat(100_000)}b`],
    ['unclosed bold', '**a '.repeat(25_000)],
  ])('stays fast on hostile input: %s', (_name, input) => {
    const started = performance.now();
    toSlackMrkdwn(input);

    expect(performance.now() - started).toBeLessThan(1000);
  });
});
