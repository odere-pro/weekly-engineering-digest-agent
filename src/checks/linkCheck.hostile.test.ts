// Hostile text must not make the link check slow (CON-6). It runs synchronously inside the write
// step, so neither the run's time limit nor its abort signal can stop it. Model output fields have
// no length cap, so every shape below is 64 KB or more. The `](` run took 534 ms at 32 KB and
// grew with the square of its length.
import { describe, expect, it } from 'vitest';
import { linkCheck } from './linkCheck';
import { renderDigest } from '../render/markdown';
import type { Digest } from '../domain/schemas';
import { makeDigest, makeItem } from '../../test/builders';

const BUDGET_MS = 1_000;
const items = [makeItem(), makeItem(), makeItem()];
const digest = makeDigest(items);

const withSummary = (summary: string): Digest => ({
  ...digest,
  items: [{ ...digest.items[0]!, summary }, ...digest.items.slice(1)],
});

const SIZE = 64 * 1024;
const repeated = (unit: string): string => unit.repeat(Math.ceil(SIZE / unit.length));

/** Shapes that make a destination or run scan start again and again, or never end. */
const HOSTILE: readonly (readonly [string, string])[] = [
  ['link openers followed by spaces', repeated('](  ')],
  ['link openers with nothing between', repeated('](')],
  ['link openers with a word between', repeated('](a')],
  ['link openers with unclosed parentheses', repeated('](a(')],
  ['link openers with an unclosed quoted title', repeated('](a "')],
  ['link openers with an unclosed single-quoted title', repeated("](a '")],
  ['link openers with an unclosed parenthesised title', repeated('](a (')],
  ['link openers with angle brackets', repeated('](<')],
  ['link openers with an angle destination that never closes', repeated('](<a ')],
  ['one very long unbalanced destination', `](${'('.repeat(SIZE)}`],
  [
    'one very long destination of closing parentheses',
    `[x](${'a'.repeat(SIZE)}${')'.repeat(SIZE)}`,
  ],
  ['a url followed by parentheses', `https://a.example/${'('.repeat(SIZE)}`],
  ['a url followed by closing parentheses', `https://a.example/${')'.repeat(SIZE)}`],
  ['a url with alternating parentheses', `https://a.example/${'()'.repeat(SIZE / 2)}`],
  ['many urls with a trailing parenthesis', repeated('https://a.example/x) ')],
  ['many urls with no space between', repeated('https://a.example/x)')],
  ['urls cut by link openers', repeated('https://a.example/](')],
  [
    'a url followed by trailing punctuation of every kind',
    `https://a.example/${'.,;:!?*_~\'"`|>)'.repeat(SIZE / 15)}`,
  ],
  ['backslashes before parentheses', repeated('\\)(\\(')],
  ['entities that decode to parentheses', repeated('&#41;&#40;')],
];

describe('linkCheck on hostile text (CON-6)', () => {
  it.each(HOSTILE)('stays fast on %s in a summary', (_name, text) => {
    const hostile = withSummary(text);
    const started = performance.now();

    linkCheck(hostile, '', items);

    expect(performance.now() - started).toBeLessThan(BUDGET_MS);
  });

  it.each(HOSTILE)('stays fast on %s in the Markdown', (_name, text) => {
    const markdown = `${renderDigest(digest, { disabledGuards: [] })}\n${text}`;
    const started = performance.now();

    linkCheck(digest, markdown, items);

    expect(performance.now() - started).toBeLessThan(BUDGET_MS);
  });

  it.each([
    ['link openers followed by spaces', repeated('](  ')],
    ['a url followed by parentheses', `https://a.example/${'('.repeat(SIZE)}`],
    ['link openers with an unclosed quoted title', repeated('](a "')],
  ])('still rejects %s', (_name, text) => {
    expect(linkCheck(withSummary(text), '', items).ok).toBe(false);
  });

  it('stays fast on 64 KB of "](  " in every field of every item at once', () => {
    const text = repeated('](  ');
    const hostile: Digest = {
      ...digest,
      headline: text,
      intro: text,
      items: digest.items.map((item) => ({
        ...item,
        title: text,
        summary: text,
        whyItMatters: text,
        action: text,
      })),
    };
    const started = performance.now();

    const result = linkCheck(hostile, text, items);

    expect(performance.now() - started).toBeLessThan(BUDGET_MS);
    expect(result.ok).toBe(false);
  });

  it('reports a bounded number of malformed links, each a short snippet', () => {
    const distinct = Array.from({ length: 5_000 }, (_, n) => `[x](${n} "unclosed`).join(' ');

    const { problems } = linkCheck(withSummary(distinct), '', items);

    expect(problems.length).toBeGreaterThan(0);
    expect(problems.length).toBeLessThanOrEqual(20);
    expect(problems.join('\n').length).toBeLessThan(5_000);
  });
});
