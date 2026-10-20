import { describe, expect, it } from 'vitest';
import { scriptedPrompts } from '../../init/__fixtures__/initHarness';
import {
  askPerspective,
  cleanTopic,
  SUGGESTED_PERSPECTIVES,
  suggestedPerspectives,
} from './perspective';

describe('suggestedPerspectives', () => {
  it('lists the four topics, then focus areas not already there (case-insensitive)', () => {
    const topics = suggestedPerspectives({ focusAreas: ['ai agents', 'Platform engineering'] });

    expect(topics.map((topic) => topic.name)).toEqual([
      'AI agents',
      'AI and LLM updates',
      'Agentic system design',
      'LLM and agent evaluations',
      'Platform engineering',
    ]);
  });
});

describe('cleanTopic', () => {
  it('strips quotes and control characters, to one line', () => {
    expect(cleanTopic('  "secur\u001b[31mity"\nfixes ')).toBe('secur [31mity fixes');
  });

  it.each(['', '   ', '""', 'x'.repeat(201)])('refuses %j', (text) => {
    expect(cleanTopic(text)).toBeUndefined();
  });

  it('accepts 200 characters', () => {
    expect(cleanTopic('x'.repeat(200))).toHaveLength(200);
  });
});

describe('askPerspective', () => {
  it('shows the suggestions with their descriptions, then "Type your own…"', async () => {
    const { prompts, calls } = scriptedPrompts();

    const topic = await askPerspective(prompts, { focusAreas: ['Platform engineering'] });

    expect(topic).toBe(SUGGESTED_PERSPECTIVES[0]?.name);
    const choices = calls[0]?.options.choices ?? [];
    expect(calls[0]?.message).toBe("This week's perspective");
    expect(choices.map((c) => c.name)).toEqual([
      ...SUGGESTED_PERSPECTIVES.map((t) => t.name),
      'Platform engineering',
      'Type your own…',
    ]);
    expect(choices[0]?.description).toBe('Agent frameworks, SDKs and coding agents that shipped');
  });

  it('returns a picked suggestion untouched', async () => {
    const { prompts, calls } = scriptedPrompts([[/perspective/, 'Agentic system design']]);

    expect(await askPerspective(prompts, { focusAreas: ['x'] })).toBe('Agentic system design');
    expect(calls).toHaveLength(1);
  });

  it('routes "Type your own…" to a validated free-text question', async () => {
    const { prompts, calls } = scriptedPrompts([
      [/perspective/, '__type-your-own__'],
      [/Topic/, 'Rust "tooling"'],
    ]);

    const topic = await askPerspective(prompts, { focusAreas: ['x'] });

    expect(topic).toBe('Rust tooling');
    const validate = calls[1]?.options.validate;
    expect(validate?.('')).toMatch(/1 to 200/);
    expect(validate?.('ok')).toBe(true);
  });
});
