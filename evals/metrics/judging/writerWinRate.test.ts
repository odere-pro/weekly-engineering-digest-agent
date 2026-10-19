import { describe, expect, it } from 'vitest';
import { writerWinRate } from './writerWinRate';

describe('writerWinRate', () => {
  it('reports each writer share of the weeks and the leader as the value', () => {
    const result = writerWinRate(['gemma', 'nemotron', 'gemma', 'gemma']);
    expect(result.value).toBe(0.75);
    expect(result.detail).toEqual({ gemma: 0.75, nemotron: 0.25 });
  });

  it('counts a writer whose tag looks like an object property', () => {
    expect(writerWinRate(['constructor', 'constructor']).detail).toEqual({ constructor: 1 });
  });

  it('is null without winners', () => {
    expect(writerWinRate([]).value).toBeNull();
  });
});
