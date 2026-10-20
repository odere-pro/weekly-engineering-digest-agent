import { describe, expect, it } from 'vitest';
import { causeChain, MAX_CAUSE_DEPTH } from './causeChain';

/** `depth` errors, each the cause of the one before; the first is the outermost. */
function chainOf(depth: number): Error[] {
  const errors: Error[] = [];
  for (let level = depth - 1; level >= 0; level--) {
    errors.unshift(new Error(`level ${level}`, errors[0] ? { cause: errors[0] } : undefined));
  }
  return errors;
}

describe('causeChain', () => {
  it('returns just the error when it has no cause', () => {
    const error = new Error('alone');

    expect(causeChain(error)).toEqual([error]);
  });

  it('lists the error first and then each cause, outermost to innermost', () => {
    const [outer, middle, inner] = chainOf(3) as [Error, Error, Error];

    expect(causeChain(outer)).toEqual([outer, middle, inner]);
  });

  it.each([
    ['a string', 'boom'],
    ['undefined', undefined],
    ['null', null],
    ['a plain object', { message: 'boom', cause: new Error('hidden') }],
  ])('returns nothing for %s: only an Error starts a chain', (_name, value) => {
    expect(causeChain(value)).toEqual([]);
  });

  it('stops at a cause that is not an Error', () => {
    const error = new Error('outer', { cause: { code: 'ECONNREFUSED' } });

    expect(causeChain(error)).toEqual([error]);
  });

  it('keeps at most MAX_CAUSE_DEPTH errors of a longer chain, from the outermost', () => {
    const errors = chainOf(MAX_CAUSE_DEPTH + 3);

    const chain = causeChain(errors[0]);

    expect(chain).toHaveLength(MAX_CAUSE_DEPTH);
    expect(chain).toEqual(errors.slice(0, MAX_CAUSE_DEPTH));
  });

  it('ends on a chain that loops back on itself', () => {
    const first = new Error('first');
    const second = new Error('second', { cause: first });
    first.cause = second;

    expect(causeChain(first)).toHaveLength(MAX_CAUSE_DEPTH);
  });

  it('does not change the errors it walks', () => {
    const inner = new Error('inner');
    const outer = new Error('outer', { cause: inner });

    causeChain(outer);

    expect(outer.cause).toBe(inner);
    expect(inner.cause).toBeUndefined();
  });
});
