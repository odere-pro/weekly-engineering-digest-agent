import { describe, expect, it } from 'vitest';
import { escapeSlack, toSlackMrkdwn } from './slackFormat';

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
    expect(toSlackMrkdwn('#   ')).toBe('#');
  });

  it('handles Windows line endings', () => {
    expect(toSlackMrkdwn('# Title\r\n\r\nbody **x**\r\n')).toBe('*Title*\n\nbody *x*\n');
  });

  describe('invisible characters', () => {
    // Written as escapes: a literal bidi override in a test file would reorder what the reader
    // of the file sees.
    it.each([
      ['a bidi override', '\u{202E}'],
      ['a bidi isolate', '\u{2066}'],
      ['a zero-width space', '\u{200B}'],
      ['the byte order mark', '\u{FEFF}'],
      ['a soft hyphen', '\u{00AD}'],
      ['a tag character', '\u{E0041}'],
      ['the Arabic letter mark', '\u{061C}'],
    ])('removes %s from the text', (_name, invisible) => {
      const output = toSlackMrkdwn(`Ollama${invisible}0.9 shipped\nsecond line${invisible}`);

      expect(output).toBe('Ollama 0.9 shipped\nsecond line');
      expect(output).not.toContain(invisible);
    });

    it('keeps the line breaks and the Markdown it converts', () => {
      expect(
        toSlackMrkdwn(
          '# Ti\u{202E}tle\n\n**bi\u{200B}g** [a\u{2066}b](https://example.com/r)\n- one\u{FEFF}\n',
        ),
      ).toBe('*Ti tle*\n\n*bi g* <https://example.com/r|a b>\n- one\n');
    });

    it('removes them before it escapes, so & < > are still escaped once', () => {
      expect(toSlackMrkdwn('a <\u{200B}!channel> & b')).toBe('a &lt; !channel&gt; &amp; b');
    });

    it('keeps a joined emoji whole', () => {
      const joined = '\u{1F468}\u{200D}\u{1F4BB}';

      expect(toSlackMrkdwn(`by ${joined}\n- ${joined} too`)).toBe(`by ${joined}\n- ${joined} too`);
    });

    it('drops a joiner that joins nothing', () => {
      expect(toSlackMrkdwn('ig\u{200D}nore')).toBe('ig nore');
    });

    it('does not make a Slack link of a URL that held an invisible character', () => {
      expect(toSlackMrkdwn('[x](https://exa\u{200B}mple.com/a)')).toBe(
        '[x](https://exa mple.com/a)',
      );
    });
  });

  it.each([
    ['unclosed brackets', '['.repeat(100_000)],
    ['unclosed links', '[a]('.repeat(25_000)],
    ['a heading with a long run of spaces', `# a${' '.repeat(100_000)}b`],
    ['unclosed bold', '**a '.repeat(25_000)],
    ['invisible characters', ' \u{202E}\u{200B}'.repeat(34_000)],
    ['a long run of trailing spaces', `a${' '.repeat(100_000)}\nb`],
    ['joiners after emoji', '\u{1F468}\u{200D}'.repeat(34_000)],
  ])('stays fast on hostile input: %s', (_name, input) => {
    const started = performance.now();
    toSlackMrkdwn(input);

    expect(performance.now() - started).toBeLessThan(1000);
  });
});
