import { describe, expect, it } from 'vitest';
import {
  DIGEST_ACTION_WORD_LIMIT,
  DIGEST_MAX_ACT_NOW,
  DIGEST_SUMMARY_WORD_LIMIT,
} from '../checks/formatCheck';
import {
  ACTION_WORD_TARGET,
  buildRetryPrompt,
  buildWritePrompt,
  SUMMARY_WORD_TARGET,
} from './writePrompt';
import { UrgencySchema } from '../domain/schemas';
import { DATA_OPEN, UNTRUSTED_DATA_RULE } from '../shared/untrusted';
import { wordCount } from '../shared/text';
import { makeScoredItem } from '../../test/builders';

const FOCUS_AREAS = ['AI models and tooling', 'Platform engineering'] as const;
const items = Array.from({ length: 3 }, (_, i) =>
  makeScoredItem({ title: `Tool ${i + 1} ships`, summary: `Tool ${i + 1} adds a feature.` }),
);
const { system, prompt } = buildWritePrompt(items, FOCUS_AREAS);

/** The system prompt lines that carry the W8-01 rules, in order. */
const ruleLines = (text: string): string[] =>
  text
    .split('\n')
    .filter((line) =>
      /^\s*(- (urgency|action|summary)\b|- At most \d+ items are act-now|act-now:|worth-a-look:|good-to-know:)/.test(
        line,
      ),
    );

describe('write prompt: urgency, action and summary (W8-01)', () => {
  it('defines the three urgency values with their fixed meanings', () => {
    expect(ruleLines(system)).toMatchInlineSnapshot(`
      [
        "- summary: one plain sentence of at most 30 words on what shipped or changed. Facts from the data only.",
        "- urgency: how soon a reader should act. Use exactly one of these three values:",
        "  act-now: a security fix, a breaking change, a deprecation or end of life with a date, or anything a team must do to keep working.",
        "  worth-a-look: a new capability that fits the focus areas.",
        "  good-to-know: everything else.",
        "- At most 3 items are act-now. If more qualify, keep act-now for the 3 a team must handle first and give the rest worth-a-look.",
        "- action: one short line, at most 15 words, with no link. For act-now, an imperative step, for example "Upgrade OpenTofu in CI and on laptops". For worth-a-look, a line that starts with "Relevant if you". For good-to-know, an empty string.",
      ]
    `);
  });

  it('names every urgency value the schema accepts', () => {
    for (const urgency of UrgencySchema.options) expect(system).toContain(urgency);
  });

  it('defines act-now as a security fix, a breaking change, a dated deprecation or a must-do', () => {
    expect(system).toMatch(/act-now:[^\n]*security fix[^\n]*breaking change[^\n]*deprecation/i);
    expect(system).toMatch(/act-now:[^\n]*end of life with a date[^\n]*keep working/i);
  });

  it('defines worth-a-look as a new capability that fits the focus areas, and the rest as good-to-know', () => {
    expect(system).toMatch(/worth-a-look:[^\n]*new capability that fits the focus areas/i);
    expect(system).toMatch(/good-to-know:[^\n]*everything else/i);
  });

  it('asks for an imperative action for act-now, "Relevant if you" for worth-a-look, and none otherwise', () => {
    expect(system).toMatch(/action:[^\n]*act-now[^\n]*imperative/i);
    expect(system).toContain('Upgrade OpenTofu in CI and on laptops');
    expect(system).toMatch(/action:[^\n]*worth-a-look[^\n]*"Relevant if you/i);
    expect(system).toMatch(/action:[^\n]*good-to-know[^\n]*empty string/i);
  });

  it('asks for one sentence of at most 30 words in the summary', () => {
    expect(SUMMARY_WORD_TARGET).toBe(30);
    expect(system).toMatch(/summary:[^\n]*one (plain )?sentence[^\n]*at most 30 words/i);
    expect(system).not.toMatch(/one or two plain sentences/i);
  });

  it('asks for an action of at most 15 words', () => {
    expect(ACTION_WORD_TARGET).toBe(15);
    expect(system).toMatch(/action:[^\n]*at most 15 words/i);
  });

  it('keeps its targets under the limits the format check enforces, so a draft has room to pass', () => {
    expect(ACTION_WORD_TARGET).toBeLessThan(DIGEST_ACTION_WORD_LIMIT);
    expect(SUMMARY_WORD_TARGET).toBeLessThan(DIGEST_SUMMARY_WORD_LIMIT);
  });

  it('states the act-now cap from the format check', () => {
    expect(system).toContain(`At most ${DIGEST_MAX_ACT_NOW} items are act-now`);
  });

  it('shows a worked example item that carries urgency and action and obeys every rule', () => {
    const line = system.split('\n').find((candidate) => candidate.startsWith('{"itemId"'));
    const example = JSON.parse(line ?? '{}') as Record<string, string>;

    expect(UrgencySchema.safeParse(example['urgency']).success).toBe(true);
    expect(example['urgency']).toBe('worth-a-look');
    expect(example['action']).toMatch(/^Relevant if you /);
    expect(wordCount(example['action'] ?? '')).toBeLessThanOrEqual(ACTION_WORD_TARGET);
    expect(wordCount(example['summary'] ?? '')).toBeLessThanOrEqual(SUMMARY_WORD_TARGET);
  });

  it('still keeps the untrusted-data rule and wraps every item', () => {
    expect(system).toContain(UNTRUSTED_DATA_RULE);
    expect(prompt.split(DATA_OPEN)).toHaveLength(items.length + 1);
  });

  it('uses no em dash', () => {
    expect(system).not.toContain('—');
    expect(prompt).not.toContain('—');
  });

  it('gives the retry the same system prompt, so a retry is asked for urgency and action too', () => {
    const retry = buildRetryPrompt(items, FOCUS_AREAS, ['Missing action in item 1']);

    expect(retry.system).toBe(system);
  });

  it('tells the retry to keep an urgency everywhere and an action on act-now and worth-a-look', () => {
    const retry = buildRetryPrompt(items, FOCUS_AREAS, ['Missing action in item 1']);

    expect(retry.prompt).toMatch(
      /keep an urgency on every item and an action on every act-now and worth-a-look item/i,
    );
    expect(retry.prompt).not.toMatch(/an action on every item/i);
  });

  it('lists the new format problems in the retry prompt', () => {
    const retry = buildRetryPrompt(items, FOCUS_AREAS, [
      'Missing action in item 1',
      'Expected at most 20 words in the action of item 2, got 27',
      'Expected at most 40 words in the summary of item 3, got 52',
      'Expected at most 3 act-now items, got 4',
      'Action of item 1 contains a link',
    ]);

    for (const problem of [
      '- Missing action in item 1',
      '- Expected at most 20 words in the action of item 2, got 27',
      '- Expected at most 40 words in the summary of item 3, got 52',
      '- Expected at most 3 act-now items, got 4',
      '- Action of item 1 contains a link',
    ]) {
      expect(retry.prompt).toContain(problem);
    }
  });
});
