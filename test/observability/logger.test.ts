import { Writable } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';
import { createLogger } from '../../src/observability/logger.js';

const SECRET = 'sk-live-0123456789';

function memoryDestination(): {
  stream: Writable;
  lines: () => Record<string, unknown>[];
  raw: () => string;
} {
  const chunks: string[] = [];
  const stream = new Writable({
    write(chunk: Buffer | string, _encoding, callback) {
      chunks.push(chunk.toString());
      callback();
    },
  });
  const raw = () => chunks.join('');
  const lines = () =>
    raw()
      .split('\n')
      .filter((line) => line.length > 0)
      .map((line) => JSON.parse(line) as Record<string, unknown>);
  return { stream, lines, raw };
}

describe('createLogger', () => {
  it('writes one JSON line with ISO time, level label, service and message', () => {
    const out = memoryDestination();
    const logger = createLogger({ level: 'info', destination: out.stream });

    logger.info('step done', { runId: 'r1', step: 'write', latencyMs: 12 });

    const [line] = out.lines();
    expect(line).toMatchObject({
      level: 'info',
      service: 'eng-digest',
      msg: 'step done',
      runId: 'r1',
      step: 'write',
      latencyMs: 12,
    });
    expect(typeof line?.['time']).toBe('string');
    expect(new Date(line?.['time'] as string).toISOString()).toBe(line?.['time']);
    expect(line).not.toHaveProperty('pid');
    expect(line).not.toHaveProperty('hostname');
  });

  it('writes percent signs in the message verbatim', () => {
    const out = memoryDestination();
    createLogger({ level: 'info', destination: out.stream }).info('100% done %s %d', { n: 1 });

    expect(out.lines()[0]?.['msg']).toBe('100% done %s %d');
  });

  it('writes a line without fields', () => {
    const out = memoryDestination();
    createLogger({ level: 'info', destination: out.stream }).warn('heads up');

    expect(out.lines()[0]).toMatchObject({ level: 'warn', msg: 'heads up' });
  });

  it('adds child fields to every line and merges nested children', () => {
    const out = memoryDestination();
    const logger = createLogger({ level: 'info', destination: out.stream });

    const run = logger.child({ runId: 'r1' });
    const model = run.child({ role: 'writer', model: 'qwen3:8b' });
    run.info('a');
    model.info('b', { tokensOut: 99 });

    const [a, b] = out.lines();
    expect(a).toMatchObject({ runId: 'r1', msg: 'a' });
    expect(a).not.toHaveProperty('role');
    expect(b).toMatchObject({ runId: 'r1', role: 'writer', model: 'qwen3:8b', tokensOut: 99 });
  });

  it('filters lines below the configured level', () => {
    const out = memoryDestination();
    const logger = createLogger({ level: 'warn', destination: out.stream });

    logger.debug('d');
    logger.info('i');
    logger.warn('w');
    logger.error('e');

    expect(out.lines().map((line) => line['level'])).toEqual(['warn', 'error']);
  });

  it('emits debug lines at debug level', () => {
    const out = memoryDestination();
    createLogger({ level: 'debug', destination: out.stream }).debug('d');

    expect(out.lines()[0]).toMatchObject({ level: 'debug', msg: 'd' });
  });

  describe('redaction', () => {
    it('replaces secret values in the message', () => {
      const out = memoryDestination();
      const logger = createLogger({
        level: 'info',
        redactValues: [SECRET],
        destination: out.stream,
      });

      logger.info(`calling with ${SECRET} now`);

      expect(out.lines()[0]?.['msg']).toBe('calling with [redacted] now');
      expect(out.raw()).not.toContain(SECRET);
    });

    it('replaces secret values in nested objects and arrays', () => {
      const out = memoryDestination();
      const logger = createLogger({
        level: 'info',
        redactValues: [SECRET],
        destination: out.stream,
      });

      logger.info('request', {
        headers: { authorization: `Bearer ${SECRET}`, accept: 'json' },
        list: ['ok', SECRET, { deep: [`x${SECRET}y`] }],
        count: 3,
        flag: true,
        nothing: null,
      });

      const [line] = out.lines();
      expect(line).toMatchObject({
        headers: { authorization: 'Bearer [redacted]', accept: 'json' },
        list: ['ok', '[redacted]', { deep: ['x[redacted]y'] }],
        count: 3,
        flag: true,
        nothing: null,
      });
      expect(out.raw()).not.toContain(SECRET);
    });

    it('redacts every occurrence and every configured secret, longest first', () => {
      const out = memoryDestination();
      const logger = createLogger({
        level: 'info',
        redactValues: ['abc', 'abcdef', 'tok-2'],
        destination: out.stream,
      });

      logger.info('abcdef abc abcdef tok-2');

      expect(out.lines()[0]?.['msg']).toBe('[redacted] [redacted] [redacted] [redacted]');
    });

    it('ignores empty secret values instead of mangling every string', () => {
      const out = memoryDestination();
      const logger = createLogger({
        level: 'info',
        redactValues: ['', SECRET],
        destination: out.stream,
      });

      logger.info('plain text', { value: 'unchanged' });

      expect(out.lines()[0]).toMatchObject({ msg: 'plain text', value: 'unchanged' });
    });

    it('redacts secrets inside child fields', () => {
      const out = memoryDestination();
      const logger = createLogger({
        level: 'info',
        redactValues: [SECRET],
        destination: out.stream,
      });

      logger.child({ url: `https://x.test/?key=${SECRET}` }).info('hi');

      expect(out.lines()[0]?.['url']).toBe('https://x.test/?key=[redacted]');
    });

    it('redacts secrets inside Error messages and stacks, keeping the error shape', () => {
      const out = memoryDestination();
      const logger = createLogger({
        level: 'error',
        redactValues: [SECRET],
        destination: out.stream,
      });

      logger.error('failed', { err: new TypeError(`bad token ${SECRET}`) });

      const err = out.lines()[0]?.['err'] as Record<string, unknown>;
      expect(err['type']).toBe('TypeError');
      expect(err['message']).toBe('bad token [redacted]');
      expect(String(err['stack'])).not.toContain(SECRET);
      expect(out.raw()).not.toContain(SECRET);
    });

    it('does not loop on circular references', () => {
      const out = memoryDestination();
      const logger = createLogger({
        level: 'info',
        redactValues: [SECRET],
        destination: out.stream,
      });
      const cyclic: Record<string, unknown> = { token: SECRET };
      cyclic['self'] = cyclic;

      logger.info('cycle', { cyclic });

      expect(out.lines()[0]).toMatchObject({ cyclic: { token: '[redacted]', self: '[circular]' } });
    });

    it('does not mutate the fields it was given', () => {
      const out = memoryDestination();
      const logger = createLogger({
        level: 'info',
        redactValues: [SECRET],
        destination: out.stream,
      });
      const fields = { nested: { token: SECRET } };

      logger.info('x', fields);

      expect(fields.nested.token).toBe(SECRET);
    });
  });

  it('writes human-readable lines in pretty mode', () => {
    const out = memoryDestination();
    const logger = createLogger({
      level: 'info',
      pretty: true,
      redactValues: [SECRET],
      destination: out.stream,
    });

    logger.info(`hello ${SECRET}`, { runId: 'r1' });

    const text = out.raw();
    expect(text).toContain('hello [redacted]');
    expect(text).toContain('runId');
    expect(text).not.toContain(SECRET);
    expect(() => JSON.parse(text) as unknown).toThrow();
  });

  it('defaults to stdout when no destination is given', () => {
    const logger = createLogger({ level: 'error' });
    expect(typeof logger.child({ a: 1 }).info).toBe('function');
  });
});

describe('createLogger hardening', () => {
  const secretLogger = (out: ReturnType<typeof memoryDestination>) =>
    createLogger({ level: 'debug', redactValues: [SECRET], destination: out.stream });

  it('redacts secrets used as object keys, in fields and in child bindings', () => {
    const out = memoryDestination();
    const logger = secretLogger(out);

    logger.info('x', { [SECRET]: 'failed', nested: { [`k-${SECRET}`]: 1 } });
    logger.child({ [SECRET]: 1 }).info('y');

    expect(out.raw()).not.toContain(SECRET);
    expect(out.lines()[0]).toMatchObject({ '[redacted]': 'failed', nested: { 'k-[redacted]': 1 } });
  });

  it('redacts the percent-encoded and JSON-escaped forms of a secret', () => {
    const out = memoryDestination();
    const tricky = 'p@ss"word\\1';
    const logger = createLogger({ level: 'info', redactValues: [tricky], destination: out.stream });

    logger.info(`url=${encodeURIComponent(tricky)} json=${JSON.stringify({ v: tricky })}`);

    expect(out.lines()[0]?.['msg']).toBe(`url=[redacted] json={"v":"[redacted]"}`);
  });

  it('replaces binary data with a size marker instead of dumping bytes', () => {
    const out = memoryDestination();

    secretLogger(out).info('bin', { buf: Buffer.from(SECRET), bytes: new Uint8Array(4) });

    expect(out.lines()[0]).toMatchObject({ buf: '[binary 18 bytes]', bytes: '[binary 4 bytes]' });
    expect(out.raw()).not.toContain(SECRET);
  });

  it('truncates structures nested deeper than the limit', () => {
    const out = memoryDestination();
    let deep: Record<string, unknown> = { leaf: SECRET };
    for (let i = 0; i < 50; i += 1) deep = { next: deep };

    secretLogger(out).info('deep', { deep });

    expect(out.raw()).toContain('[truncated]');
    expect(out.raw()).not.toContain(SECRET);
  });

  it('keeps logging when a field cannot be read, and drops only the fields', () => {
    const out = memoryDestination();
    const hostile = {
      get boom(): string {
        throw new Error('getter exploded');
      },
    };

    expect(() => {
      secretLogger(out).info('still here', hostile);
    }).not.toThrow();

    expect(out.lines()[0]).toMatchObject({ msg: 'still here', fields: '[unserializable]' });
  });

  it('does not touch the fields of a line below the configured level', () => {
    const out = memoryDestination();
    const logger = createLogger({
      level: 'error',
      redactValues: [SECRET],
      destination: out.stream,
    });
    const getter = vi.fn(() => 'v');
    const fields = Object.defineProperty({}, 'lazy', { get: getter, enumerable: true });

    logger.debug('skipped', fields);
    logger.child(fields).info('skipped too');

    expect(getter).toHaveBeenCalledTimes(1); // only the child() binding, which always applies
    expect(out.lines()).toEqual([]);
  });

  it('redacts enumerable properties of an Error, its cause and AggregateError members', () => {
    const out = memoryDestination();
    const failure = Object.assign(
      new Error('request failed', { cause: new Error(`inner ${SECRET}`) }),
      {
        response: { config: { headers: { authorization: `Bearer ${SECRET}` } } },
      },
    );
    const many = new AggregateError([new Error(`one ${SECRET}`)], 'several');

    secretLogger(out).error('boom', { err: failure, many });

    expect(out.raw()).not.toContain(SECRET);
    const line = out.lines()[0] as { err: Record<string, unknown>; many: Record<string, unknown> };
    expect(line.err['response']).toMatchObject({
      config: { headers: { authorization: 'Bearer [redacted]' } },
    });
    expect(line.err['cause']).toMatchObject({ message: 'inner [redacted]' });
    expect(line.many['errors']).toMatchObject([{ message: 'one [redacted]' }]);
  });

  it('writes Date fields as ISO strings', () => {
    const out = memoryDestination();

    secretLogger(out).info('when', { at: new Date('2026-10-16T01:02:03.000Z') });

    expect(out.lines()[0]?.['at']).toBe('2026-10-16T01:02:03.000Z');
  });

  it('writes to process.stdout when no destination is given', () => {
    const write = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);

    createLogger({ level: 'info' }).info('to stdout');

    expect(String(write.mock.calls[0]?.[0])).toContain('"msg":"to stdout"');
  });
});
