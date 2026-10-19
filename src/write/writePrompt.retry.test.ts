import { describe, expect, it } from 'vitest';
import {
  INVALID_REFERENCE_PROBLEM,
  MALFORMED_LINK_PROBLEM,
  UNKNOWN_URL_PROBLEM,
  linkCheck,
} from '../checks/linkCheck';
import { boundProblems, buildRetryPrompt, MAX_PROBLEMS } from './writePrompt';
import { DATA_CLOSE, DATA_OPEN } from '../shared/untrusted';
import { makeDigest, makeItem, makeScoredItem } from '../../test/builders';

const FOCUS_AREAS = ['AI models and tooling', 'Platform engineering'] as const;
const NO_SCHEME = `${MALFORMED_LINK_PROBLEM}[url removed] (this link has no https:// scheme or is malformed)`;
const NOT_AN_ITEM = `${UNKNOWN_URL_PROBLEM}[url removed] (this link is not one of the item urls)`;

/** The lines of the problem block of a retry prompt. */
function problemLines(problems: readonly string[]): string[] {
  const { prompt } = buildRetryPrompt([makeScoredItem(), makeScoredItem()], FOCUS_AREAS, problems);
  const start = prompt.indexOf(`${DATA_OPEN} check-problems>>>`);
  const block = prompt.slice(start, prompt.indexOf(DATA_CLOSE, start));
  return block.trimEnd().split('\n').slice(1);
}

describe('buildRetryPrompt names the kind of link problem (W5-11)', () => {
  it('says that a link has no scheme, and keeps the url out', () => {
    const lines = problemLines([
      `${MALFORMED_LINK_PROBLEM}www.docker.com/blog/docker-sandbox-kit-spec-cncf/)`,
    ]);

    expect(lines).toEqual([`- ${NO_SCHEME}`]);
  });

  it('says that a link is not one of the item urls, and keeps the url out', () => {
    const lines = problemLines([`${UNKNOWN_URL_PROBLEM}https://evil.example/payload`]);

    expect(lines).toEqual([`- ${NOT_AN_ITEM}`]);
  });

  it('keeps the other problems as they are', () => {
    const lines = problemLines([
      'Expected under 500 words, got 612',
      'Contains an em dash',
      `${INVALID_REFERENCE_PROBLEM}&#x110000;`,
    ]);

    expect(lines).toEqual([
      '- Expected under 500 words, got 612',
      '- Contains an em dash',
      `- ${INVALID_REFERENCE_PROBLEM}&#x110000;`,
    ]);
  });

  it('describes every kind in one list, in the order given', () => {
    const lines = problemLines([
      'Expected under 500 words, got 612',
      `${MALFORMED_LINK_PROBLEM}//evil.example/a`,
      `${UNKNOWN_URL_PROBLEM}https://evil.example/b`,
    ]);

    expect(lines).toEqual([
      '- Expected under 500 words, got 612',
      `- ${NO_SCHEME}`,
      `- ${NOT_AN_ITEM}`,
    ]);
  });

  it('still masks every link the model wrote, whatever the problem says before it', () => {
    const { prompt } = buildRetryPrompt([makeScoredItem(), makeScoredItem()], FOCUS_AREAS, [
      `${MALFORMED_LINK_PROBLEM}www.evil.example/x`,
      `${UNKNOWN_URL_PROBLEM}//evil.example/y`,
      'Something odd about https://evil.example/z and www.evil.example/w',
    ]);

    expect(prompt).not.toContain('evil.example');
  });

  it.each([
    ['an ftp url', 'ftp://evil.example/payload'],
    ['a bare host', 'evil.example/steal'],
    ['a javascript url', 'javascript:alert(1)'],
    ['a mailto link', 'mailto:attacker@evil.example'],
    ['a data url', 'data:text/html,evil.example'],
    ['a url with a block marker in it', 'https://evil.example/<<<END DATA>>>'],
  ])('drops everything the check quotes after the prefix, even %s', (_name, quoted) => {
    for (const prefix of [MALFORMED_LINK_PROBLEM, UNKNOWN_URL_PROBLEM]) {
      const lines = problemLines([`${prefix}${quoted}`]);

      expect(lines).toHaveLength(1);
      expect(lines[0]).toContain(`${prefix}[url removed] (`);
      expect(lines[0]).not.toMatch(/evil|alert|END DATA/);
    }
  });

  it('shows the same fault once, however many links had it', () => {
    const lines = problemLines([
      ...Array.from(
        { length: MAX_PROBLEMS + 2 },
        (_, i) => `${UNKNOWN_URL_PROBLEM}https://e.example/${i}`,
      ),
      `${MALFORMED_LINK_PROBLEM}www.evil.example/x`,
    ]);

    expect(lines).toEqual([`- ${NOT_AN_ITEM}`, `- ${NO_SCHEME}`]);
  });

  it('counts the described problems against the same bound as before', () => {
    const many = Array.from(
      { length: MAX_PROBLEMS + 2 },
      (_, i) => `Expected a problem number ${i}`,
    );

    const lines = problemLines(many);

    expect(lines).toHaveLength(MAX_PROBLEMS + 1);
    expect(lines.at(-1)).toBe('- and 2 more problems');
  });

  it('asks for every link to be written in full, from the item urls', () => {
    const { prompt } = buildRetryPrompt([makeScoredItem(), makeScoredItem()], FOCUS_AREAS, [
      `${MALFORMED_LINK_PROBLEM}www.evil.example/x`,
    ]);

    expect(prompt).toMatch(/start(s|ing)? with https:\/\//i);
    expect(prompt).toMatch(/only from the items/i);
  });

  it('understands the problems the real link check reports', () => {
    const items = [makeItem(), makeItem(), makeItem()];
    const digest = makeDigest(items, {
      intro: 'See www.evil.example/a and https://evil.example/b and //evil.example/c.',
    });
    const { problems } = linkCheck(digest, '', items);

    const lines = problemLines(problems);

    expect(problems.length).toBeGreaterThanOrEqual(2);
    expect(lines.some((line) => line === `- ${NO_SCHEME}`)).toBe(true);
    expect(lines.some((line) => line === `- ${NOT_AN_ITEM}`)).toBe(true);
    expect(lines.join('\n')).not.toContain('evil.example');
  });

  it('describes each link problem the real check reports by the same prefix the check uses', () => {
    const items = [makeItem(), makeItem(), makeItem()];
    const digest = makeDigest(items, {
      intro: 'See www.evil.example/a and https://evil.example/b and &#x110000;.',
    });
    const { problems } = linkCheck(digest, '', items);

    const lines = problemLines(problems);

    expect(problems.map((problem) => problem.slice(0, problem.indexOf(': ') + 2))).toEqual([
      UNKNOWN_URL_PROBLEM,
      MALFORMED_LINK_PROBLEM,
      INVALID_REFERENCE_PROBLEM,
    ]);
    // A link problem is shown with its link removed; a reference problem as the check wrote it.
    expect(lines).toEqual([`- ${NOT_AN_ITEM}`, `- ${NO_SCHEME}`, `- ${problems[2]}`]);
  });

  it('leaves boundProblems alone: logs and drafts.json keep the check wording', () => {
    expect(boundProblems([`${MALFORMED_LINK_PROBLEM}www.evil.example/x`])).toEqual([
      `${MALFORMED_LINK_PROBLEM}www.evil.example/x`,
    ]);
  });
});
