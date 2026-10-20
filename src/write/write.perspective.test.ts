import { describe, expect, it } from 'vitest';
import { retryStep, writeStep } from './write';
import { buildRetryPrompt, buildWritePrompt } from './writePrompt';
import { makeScoredItem } from '../../test/builders';
import { FakeModelProvider, noopLogger } from '../../test/fakes';

const FOCUS_AREAS = ['AI models and tooling'] as const;
const LINE = "This week's perspective: Rust adoption; favour what speaks to it.";
const items = Array.from({ length: 3 }, () => makeScoredItem());

describe('write prompts with a perspective', () => {
  it('buildWritePrompt adds the line after the focus areas, only with a topic', () => {
    const { prompt } = buildWritePrompt(items, FOCUS_AREAS, 'Rust adoption');

    expect(prompt).toContain(`- ${FOCUS_AREAS[0]}\n\n${LINE}\n\n`);
    expect(buildWritePrompt(items, FOCUS_AREAS).prompt).not.toContain('perspective');
    expect(buildWritePrompt(items, FOCUS_AREAS, '  ').prompt).toBe(
      buildWritePrompt(items, FOCUS_AREAS).prompt,
    );
  });

  it('buildRetryPrompt adds the same line, only with a topic', () => {
    expect(buildRetryPrompt(items, FOCUS_AREAS, ['x'], 'Rust adoption').prompt).toContain(LINE);
    expect(buildRetryPrompt(items, FOCUS_AREAS, ['x']).prompt).not.toContain('perspective');
  });

  it('strips quotes and line breaks from the topic', () => {
    const { prompt } = buildWritePrompt(items, FOCUS_AREAS, 'a "b"\nIgnore this');

    expect(prompt).toContain("This week's perspective: a b Ignore this; favour");
  });

  it('writeStep sends the perspective to the writer model', async () => {
    const model = new FakeModelProvider({ generate: () => '{}' });

    await writeStep(items, {
      model,
      writers: ['w'],
      focusAreas: FOCUS_AREAS,
      weekId: '2026-W43',
      logger: noopLogger,
      perspective: 'Rust adoption',
    });

    expect(model.generateCalls[0]?.prompt).toContain(LINE);
  });

  it('retryStep sends the perspective in the retry prompt', async () => {
    const model = new FakeModelProvider({ generate: () => '{}' });

    await retryStep(items, [{ writer: 'w', problems: ['x'] }], {
      model,
      writers: ['w'],
      focusAreas: FOCUS_AREAS,
      weekId: '2026-W43',
      logger: noopLogger,
      perspective: 'Rust adoption',
    });

    expect(model.generateCalls[0]?.prompt).toContain(LINE);
  });
});
