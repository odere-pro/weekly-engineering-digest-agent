import { describe, expect, it } from 'vitest';
import {
  CIRCULAR,
  createRedactor,
  REDACTED,
  TRUNCATED,
  UNSERIALIZABLE,
} from '../../src/observability/redact.js';

const SECRET = 'p@ss "word"\n&more';

describe('createRedactor().text', () => {
  it('replaces the secret as written, percent-encoded and JSON-escaped', () => {
    const redactor = createRedactor([SECRET]);
    const asJson = JSON.stringify({ pw: SECRET });

    expect(redactor.text(`raw ${SECRET}`)).toBe(`raw ${REDACTED}`);
    expect(redactor.text(`url ?pw=${encodeURIComponent(SECRET)}`)).toBe(`url ?pw=${REDACTED}`);
    expect(redactor.text(asJson)).toBe(`{"pw":"${REDACTED}"}`);
  });

  it('redacts a longer secret whole when a shorter one is part of it', () => {
    const redactor = createRedactor(['tok', 'tok-longer']);

    expect(redactor.text('a tok-longer b tok')).toBe(`a ${REDACTED} b ${REDACTED}`);
  });

  it('treats a secret literally, never as a pattern', () => {
    expect(createRedactor(['a.b*c(d)']).text('a.b*c(d) axbbc(d)')).toBe(`${REDACTED} axbbc(d)`);
  });

  it('ignores empty secrets and returns the text unchanged without secrets', () => {
    expect(createRedactor(['']).text('abc')).toBe('abc');
    expect(createRedactor().text('abc')).toBe('abc');
  });
});

describe('createRedactor().value', () => {
  const redactor = createRedactor(['s3cret']);

  it('cleans nested strings and keys without touching the input', () => {
    const input = { s3cret: ['x s3cret', { deep: 's3cret' }], n: 1, ok: true, none: null };

    const output = redactor.value(input);

    expect(output).toEqual({
      [REDACTED]: [`x ${REDACTED}`, { deep: REDACTED }],
      n: 1,
      ok: true,
      none: null,
    });
    expect(input.s3cret[0]).toBe('x s3cret');
  });

  it('reads an Error as plain data with its message, stack and cause cleaned', () => {
    const error = new Error('failed with s3cret', { cause: new Error('inner s3cret') });

    const output = redactor.value(error) as Record<string, unknown>;

    expect(JSON.stringify(output)).not.toContain('s3cret');
    expect(output).toMatchObject({ type: 'Error', message: `failed with ${REDACTED}` });
    expect(output['cause']).toMatchObject({ message: `inner ${REDACTED}` });
  });

  it('cleans every error of an AggregateError', () => {
    const output = redactor.value(new AggregateError([new Error('a s3cret')], 'many')) as {
      errors: { message: string }[];
    };

    expect(output.errors[0]?.message).toBe(`a ${REDACTED}`);
  });

  it('uses toJSON when an object has one', () => {
    expect(redactor.value({ toJSON: () => ({ v: 's3cret' }) })).toEqual({ v: REDACTED });
  });

  it('replaces binary data by its size', () => {
    expect(redactor.value(new Uint8Array(3))).toBe('[binary 3 bytes]');
    expect(redactor.value(new ArrayBuffer(5))).toBe('[binary 5 bytes]');
  });

  it('marks a circular reference', () => {
    const loop: Record<string, unknown> = { name: 'loop' };
    loop['self'] = loop;

    expect(redactor.value(loop)).toEqual({ name: 'loop', self: CIRCULAR });
  });

  it('cuts a structure that is nested too deeply', () => {
    let deep: unknown = 'bottom';
    for (let i = 0; i < 20; i += 1) deep = { next: deep };

    expect(JSON.stringify(redactor.value(deep))).toContain(TRUNCATED);
  });

  it('never throws: a getter that fails becomes [unserializable]', () => {
    const hostile = {
      get boom(): string {
        throw new Error('no');
      },
    };

    expect(redactor.value(hostile)).toBe(UNSERIALIZABLE);
  });
});

describe('createRedactor().fields', () => {
  const redactor = createRedactor(['s3cret']);

  it('cleans a field bag', () => {
    expect(redactor.fields({ url: 'https://h/?t=s3cret', count: 2 })).toEqual({
      url: `https://h/?t=${REDACTED}`,
      count: 2,
    });
  });

  it('never throws: fields that cannot be read are replaced', () => {
    const hostile = {
      get boom(): string {
        throw new Error('no');
      },
    };

    expect(redactor.fields(hostile)).toEqual({ fields: UNSERIALIZABLE });
  });
});
