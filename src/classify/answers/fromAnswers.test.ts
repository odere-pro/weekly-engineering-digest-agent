import { describe, expect, it } from 'vitest';
import { fromAnswers } from './fromAnswers';
import { FOCUS_AREAS, answersFor, type Answers } from '../__fixtures__/classifyKit';
import { DigestError } from '../../shared/errors';

const AREAS: ReadonlySet<string> = new Set([...FOCUS_AREAS, 'other']);
const ITEM_ID = 'item-7';

function classify(answers: Answers) {
  return fromAnswers(ITEM_ID, answers, AREAS);
}

describe('fromAnswers', () => {
  it('uses the expected level as relevance and keeps the area, its confidence and both probabilities', () => {
    const answers = answersFor({
      level: 2.4,
      area: FOCUS_AREAS[1],
      areaConfidence: 0.7,
      hype: 0.15,
      minorRelease: 0.65,
    });

    expect(classify(answers)).toEqual({
      itemId: ITEM_ID,
      relevance: 2.4,
      area: FOCUS_AREAS[1],
      areaConfidence: 0.7,
      hype: 0.15,
      minorRelease: 0.65,
    });
  });

  it('accepts "other" as an area', () => {
    expect(classify(answersFor({ area: 'other' })).area).toBe('other');
  });

  it('does not touch the answers it reads', () => {
    const answers = Object.freeze(
      Object.fromEntries(
        Object.entries(answersFor()).map(([id, answer]) => [id, Object.freeze(answer)]),
      ),
    );

    expect(() => classify(answers)).not.toThrow();
  });

  it.each(['relevance', 'area', 'hype', 'minorRelease'])(
    'fails the step when the %s answer is missing',
    (questionId) => {
      const { [questionId]: _missing, ...rest } = answersFor();

      const attempt = () => classify(rest);

      expect(attempt).toThrow(DigestError);
      expect(attempt).toThrow(new RegExp(`"${questionId}" for item ${ITEM_ID}, got none`));
    },
  );

  it('fails the step when an answer has the wrong type', () => {
    const answers = { ...answersFor(), relevance: { type: 'yesno', probability: 0.9 } } as Answers;

    expect(() => classify(answers)).toThrow(/expected a score answer to "relevance".*got yesno/);
  });

  it('fails the step when the chosen area is not an option', () => {
    const attempt = () => classify(answersFor({ area: 'Cooking' }));

    expect(attempt).toThrow(/chose area "Cooking" for item item-7, which is not an option/);
    expect(attempt).toThrow(expect.objectContaining({ step: 'classify' }));
  });
});

describe('fromAnswers range pins', () => {
  it('accepts the ends of every range', () => {
    const low = classify(answersFor({ level: 0, areaConfidence: 0, hype: 0, minorRelease: 0 }));
    const high = classify(answersFor({ level: 3, areaConfidence: 1, hype: 1, minorRelease: 1 }));

    expect([low.relevance, low.areaConfidence, low.hype, low.minorRelease]).toEqual([0, 0, 0, 0]);
    expect([high.relevance, high.areaConfidence, high.hype, high.minorRelease]).toEqual([
      3, 1, 1, 1,
    ]);
  });

  it.each([
    ['a relevance above 3', { level: 3.1 }],
    ['a negative relevance', { level: -0.1 }],
    ['an area confidence above 1', { areaConfidence: 1.1 }],
    ['a negative area confidence', { areaConfidence: -0.1 }],
    ['a hype probability above 1', { hype: 1.4 }],
    ['a negative hype probability', { hype: -0.2 }],
    ['a minor-release probability above 1', { minorRelease: 1.01 }],
  ])('fails the step on %s instead of clamping it', (_name, overrides) => {
    const attempt = () => classify(answersFor(overrides));

    expect(attempt).toThrow(DigestError);
    expect(attempt).toThrow(/invalid answers for item item-7/);
    expect(attempt).toThrow(expect.objectContaining({ step: 'classify' }));
  });
});
