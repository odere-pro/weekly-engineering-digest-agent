import { describe, expect, it } from 'vitest';
import { DEFAULT_FOCUS_AREAS } from '../../../sources/defaultSources';
import { scriptedPrompts, validatorFor } from '../__fixtures__/initHarness';
import { askFocusAreas, focusAreasProblem, mergeFocusAreas } from './focusAreas';

describe('askFocusAreas', () => {
  it('offers the default focus areas pre-ticked', async () => {
    const { prompts, calls } = scriptedPrompts();

    await askFocusAreas(prompts);

    const call = calls.find((c) => c.kind === 'checkbox' && /^Focus areas/.test(c.message));
    expect(call?.options.choices?.map((c) => [c.value, c.checked])).toEqual(
      DEFAULT_FOCUS_AREAS.map((area) => [area, true]),
    );
  });

  it('returns the defaults when the user just presses Enter', async () => {
    const { prompts } = scriptedPrompts();

    expect(await askFocusAreas(prompts)).toEqual([...DEFAULT_FOCUS_AREAS]);
  });

  it('merges ticked and typed focus areas without duplicates', async () => {
    const { prompts } = scriptedPrompts([
      [/^Focus areas/, ['AI models and tooling']],
      [/Other focus areas/, ' Kubernetes ,ai models and tooling,, Observability '],
    ]);

    expect(await askFocusAreas(prompts)).toEqual([
      'AI models and tooling',
      'Kubernetes',
      'Observability',
    ]);
  });

  it('rejects an empty or oversized focus area list in the free-text prompt', async () => {
    async function freeTextValidator(picked: string[]): Promise<(value: string) => true | string> {
      const { prompts, calls } = scriptedPrompts([
        [/^Focus areas/, picked],
        [/Other focus areas/, 'Kubernetes'],
      ]);
      await askFocusAreas(prompts);
      return validatorFor(calls, /Other focus areas/);
    }
    const tooMany = Array.from({ length: 25 }, (_, i) => `area ${String(i)}`).join(',');

    const nothingPicked = await freeTextValidator([]);
    const onePicked = await freeTextValidator(['one']);

    expect(nothingPicked('')).not.toBe(true);
    expect(nothingPicked('Kubernetes')).toBe(true);
    expect(onePicked('')).toBe(true);
    expect(onePicked(tooMany)).not.toBe(true);
    expect(onePicked('ONE')).toBe(true);
  });
});

describe('mergeFocusAreas', () => {
  it('keeps the ticked areas first, then the typed ones', () => {
    expect(mergeFocusAreas(['b', 'a'], 'c, d')).toEqual(['b', 'a', 'c', 'd']);
  });

  it('trims every name and drops empty ones', () => {
    expect(mergeFocusAreas([' a '], ',  , b ,')).toEqual(['a', 'b']);
  });

  it('drops a repeat ignoring case, and the first spelling wins', () => {
    expect(mergeFocusAreas(['AI Tooling'], 'ai tooling, AI TOOLING, Other')).toEqual([
      'AI Tooling',
      'Other',
    ]);
  });

  it('does not change the list it was given', () => {
    const picked = ['a'];

    mergeFocusAreas(picked, 'b');

    expect(picked).toEqual(['a']);
  });
});

describe('focusAreasProblem', () => {
  it('has nothing to say about a valid list', () => {
    expect(focusAreasProblem(['a', 'b'])).toBeUndefined();
  });

  it('says so, with the field name, when the list is empty', () => {
    expect(focusAreasProblem([])).toMatch(/^Focus areas: /);
  });

  it('refuses more than 25 areas', () => {
    const many = Array.from({ length: 26 }, (_, i) => `area ${String(i)}`);

    expect(focusAreasProblem(many)).toMatch(/^Focus areas: /);
  });
});
