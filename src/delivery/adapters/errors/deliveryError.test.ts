import { describe, expect, it } from 'vitest';
import {
  causeOf,
  DeliveryError,
  deliveryFacts,
  describeError,
  MAX_CAUSE_DEPTH,
  statedFacts,
} from './deliveryError';

function withProps(error: Error, props: Record<string, unknown>): Error {
  return Object.assign(error, props);
}

/** An error with `levels` errors in its cause chain, the outermost first. */
function chainOf(levels: number): Error[] {
  const errors: Error[] = [];
  for (let level = levels; level >= 1; level--) {
    errors.unshift(new Error(`e${String(level)}`, { cause: errors[0] }));
  }
  return errors;
}

/** An AggregateError wrapped in `wraps` more AggregateErrors, around one error saying "bottom". */
function nestedAggregate(wraps: number): AggregateError {
  let nested = new AggregateError([new Error('bottom')]);
  for (let wrap = 0; wrap < wraps; wrap++) nested = new AggregateError([nested]);
  return nested;
}

describe('DeliveryError', () => {
  it('is an Error named DeliveryError that carries only what it was given', () => {
    const error = new DeliveryError('Slack webhook answered HTTP 503', { status: 503 });

    expect(error).toBeInstanceOf(Error);
    expect(error.name).toBe('DeliveryError');
    expect(error.status).toBe(503);
    expect(error.code).toBeUndefined();
    expect(error.cause).toBeUndefined();
  });

  it('carries every fact it was given and the cause', () => {
    const cause = new Error('inner');

    const error = new DeliveryError('boom', {
      code: 'ESOCKET',
      originalCode: 'ECONNREFUSED',
      status: 502,
      responseCode: 451,
      timeoutType: 'SOCKET_TIMEOUT',
      cause,
    });

    expect(error).toMatchObject({
      code: 'ESOCKET',
      originalCode: 'ECONNREFUSED',
      status: 502,
      responseCode: 451,
      timeoutType: 'SOCKET_TIMEOUT',
    });
    expect(error.cause).toBe(cause);
  });

  it('has no own cause property when none was given', () => {
    expect('cause' in new DeliveryError('boom')).toBe(false);
    expect('cause' in new DeliveryError('boom', { cause: undefined })).toBe(false);
  });

  it('shows the name it was given instead of DeliveryError', () => {
    expect(new DeliveryError('boom', { name: 'TypeError' }).name).toBe('TypeError');
  });
});

describe('statedFacts', () => {
  it('reads the identifiers and integers an error states', () => {
    const stated = withProps(new Error('boom'), {
      code: 'ESOCKET',
      originalCode: 'ECONNREFUSED',
      status: 503,
      responseCode: 421,
      timeoutType: 'GREETING_TIMEOUT',
    });

    expect(statedFacts(stated)).toStrictEqual({
      code: 'ESOCKET',
      originalCode: 'ECONNREFUSED',
      status: 503,
      responseCode: 421,
      timeoutType: 'GREETING_TIMEOUT',
    });
  });

  it.each([
    ['a numeric code (a DOMException has one)', { code: 23 }],
    ['a code with spaces', { code: 'see https://h.test/hook?t=hunter2' }],
    ['a code of 65 characters', { code: 'A'.repeat(65) }],
    ['an empty code', { code: '' }],
    ['an original code that is text', { originalCode: 'bad code' }],
    ['a timeout type that is text', { timeoutType: 'a b' }],
    ['a status that is a string', { status: '503' }],
    ['a status that is not an integer', { status: 503.5 }],
    ['an SMTP reply code that is a string', { responseCode: '451' }],
  ])('leaves out %s', (_name, props) => {
    expect(statedFacts(withProps(new Error('boom'), props))).toStrictEqual({
      code: undefined,
      originalCode: undefined,
      status: undefined,
      responseCode: undefined,
      timeoutType: undefined,
    });
  });

  it('keeps a 64-character identifier', () => {
    const code = 'A'.repeat(64);

    expect(statedFacts({ code }).code).toBe(code);
  });

  it.each([undefined, null, 'ECONNREFUSED', 503, true])('states nothing for %j', (value) => {
    expect(statedFacts(value)).toStrictEqual({});
  });
});

describe('causeOf', () => {
  it('is the cause of an Error', () => {
    const cause = new Error('inner');

    expect(causeOf(new Error('outer', { cause }))).toBe(cause);
  });

  it('is nothing for an Error without a cause, and for a value that is not an Error', () => {
    expect(causeOf(new Error('outer'))).toBeUndefined();
    expect(causeOf({ cause: new Error('inner') })).toBeUndefined();
    expect(causeOf('text')).toBeUndefined();
  });
});

describe('deliveryFacts', () => {
  it('takes each fact from the outermost error that states it', () => {
    const inner = withProps(new Error('inner'), { code: 'ECONNRESET', status: 502 });
    const outer = withProps(new Error('outer', { cause: inner }), { code: 'EOUTER' });

    expect(deliveryFacts(outer)).toMatchObject({ code: 'EOUTER', status: 502 });
  });

  it('finds the code on the cause, as fetch reports it', () => {
    const cause = withProps(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' });

    expect(deliveryFacts(new TypeError('fetch failed', { cause })).code).toBe('ECONNREFUSED');
  });

  it('states nothing for an error without facts, and for a value that is not an object', () => {
    const none = {
      code: undefined,
      originalCode: undefined,
      status: undefined,
      responseCode: undefined,
      timeoutType: undefined,
    };

    expect(deliveryFacts(new Error('plain'))).toStrictEqual(none);
    expect(deliveryFacts('timeout')).toStrictEqual(none);
    expect(deliveryFacts(undefined)).toStrictEqual({});
    expect(deliveryFacts(null)).toStrictEqual({});
  });

  it('reads only the first levels of the cause chain', () => {
    const chain = chainOf(MAX_CAUSE_DEPTH + 1);
    Object.assign(chain[MAX_CAUSE_DEPTH - 1]!, { status: 503 });
    Object.assign(chain[MAX_CAUSE_DEPTH]!, { code: 'TOO_DEEP' });

    const facts = deliveryFacts(chain[0]);

    expect(facts.status).toBe(503);
    expect(facts.code).toBeUndefined();
  });

  it('ends on a cause chain that loops back on itself', () => {
    const a = withProps(new Error('a'), { status: 500 });
    const b = new Error('b', { cause: a });
    Object.assign(a, { cause: b });

    expect(deliveryFacts(a).status).toBe(500);
  });
});

describe('describeError', () => {
  it('is the message of an Error and the text of anything else', () => {
    expect(describeError(new Error('boom'))).toBe('boom');
    expect(describeError('timeout')).toBe('timeout');
  });

  it('is the distinct messages of an AggregateError that has none of its own', () => {
    const aggregate = new AggregateError([
      new Error('connect ECONNREFUSED ::1:25'),
      new Error('connect ECONNREFUSED 127.0.0.1:25'),
      new Error('connect ECONNREFUSED ::1:25'),
    ]);

    expect(describeError(aggregate)).toBe(
      'connect ECONNREFUSED ::1:25; connect ECONNREFUSED 127.0.0.1:25',
    );
  });

  it('keeps the message an AggregateError has', () => {
    expect(describeError(new AggregateError([new Error('inner')], 'all failed'))).toBe(
      'all failed',
    );
  });

  it('flattens a nested AggregateError and skips an inner error with no message', () => {
    const nested = new AggregateError([
      new AggregateError([new Error('deep one'), new Error('deep two')]),
      new Error(''),
      new Error('shallow'),
    ]);

    expect(describeError(nested)).toBe('deep one; deep two; shallow');
  });

  it('looks inside nested aggregates for a bounded number of levels', () => {
    expect(describeError(nestedAggregate(MAX_CAUSE_DEPTH - 1))).toBe('bottom');
    expect(describeError(nestedAggregate(MAX_CAUSE_DEPTH))).toBe('');
  });
});
