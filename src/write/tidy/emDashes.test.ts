import { describe, expect, it } from 'vitest';
import { withoutEmDashes } from './emDashes';

const DASH = '—';

describe('withoutEmDashes', () => {
  it.each([
    ['a dash between words', `Fast ${DASH} faster`, 'Fast, faster'],
    ['a dash with no spaces around it', `Fast${DASH}faster`, 'Fast, faster'],
    ['a run of dashes', `Fast ${DASH}${DASH} faster`, 'Fast, faster'],
    ['a dash with a comma already in front', `Fast, ${DASH} faster`, 'Fast, faster'],
    ['spaces, commas and dashes mixed in one run', `A , ${DASH} ${DASH} , B`, 'A, B'],
    ['two separate dashes', `A ${DASH} B ${DASH} C`, 'A, B, C'],
  ])('turns %s into one comma', (_name, text, expected) => {
    expect(withoutEmDashes(text)).toBe(expected);
  });

  it.each([
    ['the start of the text', `${DASH} Runners`, 'Runners'],
    ['the end of the text', `Runners ${DASH}`, 'Runners'],
    ['both ends of the text', `${DASH} Runners, ${DASH} gateways ${DASH}`, 'Runners, gateways'],
    ['a text that is only a dash', DASH, ''],
  ])('drops a dash at %s', (_name, text, expected) => {
    expect(withoutEmDashes(text)).toBe(expected);
  });

  it.each([
    ['text with no dash', 'Runners and gateways'],
    ['a hyphen', 'build-time'],
    ['an en dash', 'v1–v2'],
    ['an empty text', ''],
  ])('leaves %s alone', (_name, text) => {
    expect(withoutEmDashes(text)).toBe(text);
  });
});
