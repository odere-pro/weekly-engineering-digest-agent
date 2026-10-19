import { describe, expect, it } from 'vitest';
import { factTokensOf, missingFacts } from './factTokens';

describe('factTokensOf', () => {
  it.each([
    ['v1.2.0', ['1.2.0']],
    ['1.2.0', ['1.2.0']],
    ['V10.0', ['10.0']],
    ['tool 1.2.3.4 shipped', ['1.2.3.4']],
    ['Kubernetes v1.34 is out', ['1.34']],
    ['(v1.2.0), then 1.3.0; and v2.0.0:', ['1.2.0', '1.3.0', '2.0.0']],
    ['go1.22.0 and node18.2.0', ['1.22.0', '18.2.0']],
  ])('finds the dotted versions in %j', (text, expected) => {
    expect(factTokensOf(text)).toEqual(expected);
  });

  it.each([
    ['v2.0.0-rc.1', ['2.0.0-rc.1']],
    ['V2.0.0-RC.1', ['2.0.0-rc.1']],
    ['1.2.0-beta', ['1.2.0-beta']],
    ['1.2.0-rc1 is out', ['1.2.0-rc1']],
    ['1.2.0-alpha.2', ['1.2.0-alpha.2']],
    ['1.2.0-preview', ['1.2.0-preview']],
    ['2.0.0-nightly.20261019', ['2.0.0-nightly.20261019']],
    ['Python 3.13.0rc1', ['3.13.0rc1']],
    ['Python 3.12.0b1 and 3.12.0a7', ['3.12.0b1', '3.12.0a7']],
    ['go1.22rc1', ['1.22rc1']],
    ['ruby 3.4.0.preview1', ['3.4.0.preview1']],
  ])('keeps the pre-release suffix of %j', (text, expected) => {
    expect(factTokensOf(text)).toEqual(expected);
  });

  it.each([
    ['gpt-4.1-mini', ['4.1']],
    ['DeepSeek-V4.1-Flash', ['4.1']],
    ['claude-3.5-sonnet', ['3.5']],
    ['Qwen2.5-Coder-32B', ['2.5']],
    ['Node 20.11-based images', ['20.11']],
    ['1.2.0-compatible', ['1.2.0']],
    ['1.2.0-development', ['1.2.0']],
    ['amazon-nova-2.5-sonic', ['2.5']],
    ['a 7.5B model and 1.5b weights', ['7.5', '1.5']],
  ])('does not take a hyphenated name for a pre-release in %j', (text, expected) => {
    expect(factTokensOf(text)).toEqual(expected);
  });

  it.each([
    ['Released v1.2.0.', ['1.2.0']],
    ['Released v1.2.0...', ['1.2.0']],
    ['Try v2.0.0-rc.1.', ['2.0.0-rc.1']],
  ])('drops the dots that close a sentence in %j', (text, expected) => {
    expect(factTokensOf(text)).toEqual(expected);
  });

  it('does not cut a version that is followed by units', () => {
    expect(factTokensOf('2.5x faster, 1.5M tokens')).toEqual(['2.5', '1.5']);
  });

  it('does not read the tail of a long dotted chain as a second version', () => {
    expect(factTokensOf('1.2.3.4.5.6')).toEqual(['1.2.3.4']);
  });

  it.each([
    ['CVE-2026-12345', ['cve-2026-12345']],
    ['cve-2026-1234 and CVE-2025-0001', ['cve-2026-1234', 'cve-2025-0001']],
    ['patched CVE-2026-1234567.', ['cve-2026-1234567']],
  ])('finds the CVE ids in %j', (text, expected) => {
    expect(factTokensOf(text)).toEqual(expected);
  });

  it.each([['CVE-2026-123'], ['CVE-26-12345'], ['CVE 2026-12345'], ['CVE-2026-']])(
    'ignores %j, which is not a CVE id',
    (text) => {
      expect(factTokensOf(text)).toEqual([]);
    },
  );

  it.each([
    ['GHSA-abcd-1234-wxyz', ['ghsa-abcd-1234-wxyz']],
    ['See GHSA-ABCD-1234-WXYZ.', ['ghsa-abcd-1234-wxyz']],
  ])('finds the GitHub advisory ids in %j', (text, expected) => {
    expect(factTokensOf(text)).toEqual(expected);
  });

  it.each([['GHSA-abcd-1234'], ['GHSA-abcd-1234-wxyzq'], ['GHSA-abc-1234-wxyz']])(
    'ignores %j, which is not a GitHub advisory id',
    (text) => {
      expect(factTokensOf(text)).toEqual([]);
    },
  );

  it.each([
    ['Shipped on 2026-10-19.', ['2026-10-19']],
    ['2026-10-19T12:00:00Z', ['2026-10-19']],
    ['from 2026-01-31 to 2026-02-01', ['2026-01-31', '2026-02-01']],
  ])('finds the ISO dates in %j', (text, expected) => {
    expect(factTokensOf(text)).toEqual(expected);
  });

  it.each([['2026-13-01'], ['2026-10-32'], ['2026-00-10'], ['12026-10-19'], ['2026-10-190']])(
    'ignores %j, which is not an ISO date',
    (text) => {
      expect(factTokensOf(text)).toEqual([]);
    },
  );

  it.each([
    ['Python 3 and GPT-5'],
    ['up to 100% faster in 2024'],
    ['5 nodes, 12 regions'],
    ['version one point two'],
    ['v2'],
    ['1.'],
    ['.5'],
    [''],
  ])('finds nothing in %j', (text) => {
    expect(factTokensOf(text)).toEqual([]);
  });

  it('lists each token once, in the order it first appears', () => {
    const text = 'CVE-2026-1111 fixed in v1.2.0 on 2026-10-19; 2.0.0 later, v1.2.0 again, 1.2.0.';

    expect(factTokensOf(text)).toEqual(['cve-2026-1111', '1.2.0', '2026-10-19', '2.0.0']);
  });
});

describe('factTokensOf on hostile input', () => {
  const LONG = 100_000;

  it.each([
    ['digits only', '9'.repeat(LONG)],
    ['digits and dots', '1.'.repeat(LONG / 2)],
    ['digits and dots, then a letter', `${'1.'.repeat(LONG / 2)}x`],
    ['one dot after a run of digits', `${'7'.repeat(LONG)}.`],
    ['runs of digits split by dots', '12345.'.repeat(LONG / 6)],
    ['letters and digits', '1a'.repeat(LONG / 2)],
    ['v prefixes', 'v'.repeat(LONG)],
    ['a pre-release suffix of dots', `1.2.0-${'a.'.repeat(LONG / 2)}`],
    ['pre-release words', '1.2.0-rc'.repeat(LONG / 8)],
    ['pre-release numbers', `1.2.0-rc${'1.'.repeat(LONG / 2)}`],
    ['glued pre-release letters', '1.2b'.repeat(LONG / 4)],
    ['v and a digit', 'v9'.repeat(LONG / 2)],
    ['a short version and a letter', '1.2-a'.repeat(LONG / 5)],
    ['CVE prefixes', 'CVE-'.repeat(LONG / 4)],
    ['a CVE number of any length', `CVE-2026-${'1'.repeat(LONG)}`],
    ['advisory prefixes', 'GHSA-abcd-'.repeat(LONG / 10)],
    ['date pieces', '2026-10-'.repeat(LONG / 8)],
    ['dashes and digits', '2026-'.repeat(LONG / 5)],
  ])('stays fast on %s', (_name, text) => {
    const started = performance.now();

    factTokensOf(text);

    expect(performance.now() - started).toBeLessThan(1_000);
  });

  it('still finds a fact at the end of a long text', () => {
    expect(factTokensOf(`${'no facts here. '.repeat(LONG / 15)}v3.1.4`)).toEqual(['3.1.4']);
  });
});

describe('missingFacts', () => {
  const source = {
    title: 'tool v1.2.0: CVE-2026-1111 fixed',
    summary: 'Shipped on 2026-10-19 with GHSA-abcd-1234-wxyz.',
  };

  it('is empty when every fact of the text is in the source title or summary', () => {
    const written = 'tool 1.2.0 fixes CVE-2026-1111 (GHSA-abcd-1234-wxyz), shipped 2026-10-19.';

    expect(missingFacts(written, source)).toEqual([]);
  });

  it('lists a version the source does not have', () => {
    expect(missingFacts('tool v1.3.0 is out', source)).toEqual(['1.3.0']);
  });

  it('lists a CVE id the source does not have', () => {
    expect(missingFacts('Fixes CVE-2026-2222.', source)).toEqual(['cve-2026-2222']);
  });

  it('lists a date the source does not have, and accepts the one it has', () => {
    expect(missingFacts('On 2026-10-20 and 2026-10-19', source)).toEqual(['2026-10-20']);
  });

  it('treats v1.2.0 in the text and 1.2.0 in the source as the same fact', () => {
    expect(missingFacts('Update to v1.2.0', { title: 'Release 1.2.0', summary: '' })).toEqual([]);
  });

  it('does not treat a release candidate as the final version', () => {
    expect(missingFacts('Ships 2.0.0 today', { title: 'v2.0.0-rc.1', summary: '' })).toEqual([
      '2.0.0',
    ]);
  });

  it('reads the title when the source has no summary', () => {
    expect(missingFacts('tool v1.2.0', { title: 'tool v1.2.0' })).toEqual([]);
    expect(missingFacts('tool v1.3.0', { title: 'tool v1.2.0' })).toEqual(['1.3.0']);
  });

  it('finds a fact in the summary that the title lacks', () => {
    expect(
      missingFacts('v1.2.0', { title: 'Release notes', summary: 'Version 1.2.0 is out' }),
    ).toEqual([]);
  });

  it('does not join the end of the title with the start of the summary', () => {
    expect(missingFacts('1.2.0', { title: 'v1.2', summary: '0 breaking changes' })).toEqual([
      '1.2.0',
    ]);
  });

  it('lists each missing fact once, in the order of the text', () => {
    expect(missingFacts('v9.9.9, CVE-2026-9999, v9.9.9 and 8.8.8', source)).toEqual([
      '9.9.9',
      'cve-2026-9999',
      '8.8.8',
    ]);
  });

  it('is empty for a text with no facts', () => {
    expect(missingFacts('Adds a faster cache', source)).toEqual([]);
  });

  it('does not accept a shorter version than the one the source has', () => {
    expect(missingFacts('v1.2', { title: 'v1.2.0', summary: '' })).toEqual(['1.2']);
  });
});
