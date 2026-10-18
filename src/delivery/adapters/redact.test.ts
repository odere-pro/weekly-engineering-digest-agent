import { describe, expect, it } from 'vitest';
import { DeliveryError, MAX_CAUSE_DEPTH } from './deliveryError';
import { redactedError, redactSecrets } from './redact';

describe('redactSecrets', () => {
  it('replaces every occurrence of every secret', () => {
    expect(redactSecrets('a SECRET b SECRET c TOKEN', ['SECRET', 'TOKEN'])).toBe(
      'a [redacted] b [redacted] c [redacted]',
    );
  });

  it('removes the longer secret whole when one contains the other', () => {
    expect(redactSecrets('see https://h.test/ now', ['https://h.test', 'https://h.test/'])).toBe(
      'see [redacted] now',
    );
  });

  it('ignores empty secrets instead of mangling the text', () => {
    expect(redactSecrets('plain text', ['', 'absent'])).toBe('plain text');
  });
});

const SECRET = 'hunter2';

/** Every string an error chain can print: names, messages and stacks, all the way down. */
function chainText(error: unknown): string {
  const parts: string[] = [];
  for (let node = error, depth = 0; node instanceof Error && depth < 20; depth++) {
    parts.push(node.name, node.message, node.stack ?? '');
    node = node.cause;
  }
  return parts.join('\n');
}

function withProps(error: Error, props: Record<string, unknown>): Error {
  return Object.assign(error, props);
}

describe('redactedError', () => {
  it('builds a prefixed delivery error with the secrets removed', () => {
    const error = redactedError('Delivery failed', new Error('bad password hunter2'), [SECRET]);

    expect(error).toBeInstanceOf(DeliveryError);
    expect(error.message).toBe('Delivery failed: bad password [redacted]');
    expect(error.cause).toBeUndefined();
    expect('cause' in error).toBe(false);
  });

  it('accepts a thrown value that is not an Error', () => {
    expect(redactedError('Delivery failed', 'timeout', []).message).toBe(
      'Delivery failed: timeout',
    );
  });

  it('leaves the original error untouched', () => {
    const original = withProps(new Error('bad password hunter2'), { code: 'EAUTH' });

    redactedError('Delivery failed', original, [SECRET]);

    expect(original.message).toBe('bad password hunter2');
    expect(original).not.toBeInstanceOf(DeliveryError);
  });

  describe('typed facts', () => {
    it('keeps the code, the HTTP status, the SMTP reply code and the timeout type', () => {
      const original = withProps(new Error('boom'), {
        code: 'ETIMEDOUT',
        status: 503,
        responseCode: 451,
        timeoutType: 'GREETING_TIMEOUT',
      });

      const error = redactedError('Delivery failed', original, []);

      expect(error).toMatchObject({
        code: 'ETIMEDOUT',
        status: 503,
        responseCode: 451,
        timeoutType: 'GREETING_TIMEOUT',
      });
    });

    it('keeps the system code nodemailer moved to originalCode', () => {
      const original = withProps(new Error('connect ECONNREFUSED 127.0.0.1:587'), {
        code: 'ESOCKET',
        originalCode: 'ECONNREFUSED',
        command: 'CONN',
      });

      const error = redactedError('SMTP delivery failed', original, []);

      expect(error.code).toBe('ESOCKET');
      expect(error.originalCode).toBe('ECONNREFUSED');
    });

    it('finds the code on the cause, as fetch reports it', () => {
      const cause = withProps(new Error('connect ECONNREFUSED ::1:9'), { code: 'ECONNREFUSED' });
      const original = new TypeError('fetch failed', { cause });

      const error = redactedError('Slack webhook request failed', original, []);

      expect(error.code).toBe('ECONNREFUSED');
      expect(error.status).toBeUndefined();
    });

    it('takes the facts of the outermost error that has them', () => {
      const cause = withProps(new Error('inner'), { code: 'ECONNRESET', status: 502 });
      const original = withProps(new Error('outer', { cause }), { code: 'EOUTER' });

      const error = redactedError('Delivery failed', original, []);

      expect(error.code).toBe('EOUTER');
      expect(error.status).toBe(502);
    });

    it.each([
      ['a numeric code (a DOMException has one)', { code: 23 }],
      ['a code that is not a plain identifier', { code: 'see https://h.test/hook?t=hunter2' }],
      ['an empty code', { code: '' }],
      ['a status that is not a number', { status: '503' }],
      ['a status that is not an integer', { status: 503.5 }],
      ['an SMTP reply code that is not a number', { responseCode: '451' }],
    ])('drops %s', (_name, props) => {
      const error = redactedError('Delivery failed', withProps(new Error('boom'), props), []);

      expect(error.code).toBeUndefined();
      expect(error.status).toBeUndefined();
      expect(error.responseCode).toBeUndefined();
    });

    it('removes a secret from the fact fields too, even one shaped like an identifier', () => {
      const original = withProps(
        new Error('boom', { cause: withProps(new Error('inner'), { code: 'hunter2' }) }),
        {
          code: 'hunter2',
          originalCode: 'hunter2',
          timeoutType: 'hunter2',
        },
      );

      const error = redactedError('Delivery failed', original, [SECRET]);

      expect(JSON.stringify([error.code, error.originalCode, error.timeoutType])).not.toContain(
        SECRET,
      );
      expect(JSON.stringify((error.cause as DeliveryError).code)).not.toContain(SECRET);
      expect(chainText(error)).not.toContain(SECRET);
    });

    it('reads the facts of a thrown object that is not an Error', () => {
      const error = redactedError('Delivery failed', { code: 'ECONNREFUSED' }, []);

      expect(error.code).toBe('ECONNREFUSED');
      expect(error.message).toBe('Delivery failed: [object Object] (ECONNREFUSED)');
    });
  });

  describe('message', () => {
    it('names the code when the text hides it, as `fetch failed` does', () => {
      const cause = withProps(new Error('connect ECONNREFUSED ::1:9'), { code: 'ECONNREFUSED' });

      const error = redactedError(
        'Slack webhook request failed',
        new TypeError('fetch failed', { cause }),
        [],
      );

      expect(error.message).toBe('Slack webhook request failed: fetch failed (ECONNREFUSED)');
    });

    it('names the system code nodemailer keeps under its own, when the text lacks it', () => {
      const original = withProps(new Error('Connection closed'), {
        code: 'ESOCKET',
        originalCode: 'ECONNRESET',
      });

      expect(redactedError('SMTP delivery failed', original, []).message).toBe(
        'SMTP delivery failed: Connection closed (ECONNRESET)',
      );
    });

    it('does not repeat a code the text already names', () => {
      const original = withProps(new Error('connect ECONNREFUSED 127.0.0.1:587'), {
        code: 'ESOCKET',
        originalCode: 'ECONNREFUSED',
      });

      expect(redactedError('SMTP delivery failed', original, []).message).toBe(
        'SMTP delivery failed: connect ECONNREFUSED 127.0.0.1:587',
      );
    });

    it('adds nothing for an error with no code', () => {
      expect(redactedError('Delivery failed', new Error('boom'), []).message).toBe(
        'Delivery failed: boom',
      );
    });

    it('names the code of an error with no text at all', () => {
      const original = withProps(new Error(''), { code: 'ECONNREFUSED' });

      expect(redactedError('Delivery failed', original, []).message).toBe(
        'Delivery failed: ECONNREFUSED',
      );
    });
  });

  describe('redacted cause', () => {
    it('keeps the cause chain of the original with every secret removed', () => {
      const deepest = withProps(new Error('socket to hunter2 reset'), { code: 'ECONNRESET' });
      const middle = new Error('request hunter2 failed', { cause: deepest });
      const original = new TypeError('fetch failed hunter2', { cause: middle });

      const error = redactedError('Slack webhook request failed', original, [SECRET]);

      expect(error.cause).toBeInstanceOf(Error);
      const first = error.cause as Error;
      expect(first.message).toBe('request [redacted] failed');
      expect(first.name).toBe('Error');
      const second = first.cause as Error;
      expect(second.message).toBe('socket to [redacted] reset');
      expect((second as DeliveryError).code).toBe('ECONNRESET');
      expect(second.cause).toBeUndefined();
      expect(chainText(error)).not.toContain(SECRET);
    });

    it('is a copy: the original cause is not reachable from the new error', () => {
      const cause = new Error('hunter2 inside');
      const error = redactedError('Delivery failed', new Error('outer', { cause }), [SECRET]);

      expect(error.cause).not.toBe(cause);
      expect(cause.message).toBe('hunter2 inside');
    });

    it('redacts a cause that is a string and keeps it as an error', () => {
      const original = new Error('outer', { cause: 'refused for hunter2' });

      const error = redactedError('Delivery failed', original, [SECRET]);

      expect((error.cause as Error).message).toBe('refused for [redacted]');
      expect(chainText(error)).not.toContain(SECRET);
    });

    it('keeps the name of each cause but redacts it too', () => {
      const cause = new Error('inner');
      cause.name = 'Failure-hunter2';

      const error = redactedError('Delivery failed', new Error('outer', { cause }), [SECRET]);

      expect((error.cause as Error).name).toBe('Failure-[redacted]');
    });

    it('stops after a bounded number of levels', () => {
      let chain: Error = new Error('level 0');
      for (let level = 1; level < 30; level++) {
        chain = new Error(`level ${String(level)}`, { cause: chain });
      }

      const error = redactedError('Delivery failed', chain, []);

      // The error itself is the first level, its copies of the causes are the rest.
      let causes = 0;
      for (let node: unknown = error.cause; node instanceof Error; node = node.cause) causes++;
      expect(causes).toBe(MAX_CAUSE_DEPTH - 1);
    });

    it('does not print a secret through the stack of the new errors', () => {
      const original = new Error('hunter2 at the top', { cause: new Error('hunter2 below') });

      const error = redactedError('Delivery failed', original, [SECRET]);

      expect(chainText(error)).not.toContain(SECRET);
    });
  });

  describe('AggregateError', () => {
    it('builds its message from the inner errors, which have none of their own', () => {
      const original = withProps(
        new AggregateError([
          new Error('connect ECONNREFUSED ::1:9'),
          new Error('connect ECONNREFUSED 127.0.0.1:9'),
        ]),
        { code: 'ECONNREFUSED' },
      );

      const error = redactedError('Slack webhook request failed', original, []);

      expect(error.message).toBe(
        'Slack webhook request failed: connect ECONNREFUSED ::1:9; connect ECONNREFUSED 127.0.0.1:9',
      );
      expect(error.code).toBe('ECONNREFUSED');
    });

    it('names each distinct inner message once and redacts it', () => {
      const original = new AggregateError([
        new Error('refused hunter2'),
        new Error('refused hunter2'),
        new Error('timed out'),
      ]);

      const error = redactedError('Delivery failed', original, [SECRET]);

      expect(error.message).toBe('Delivery failed: refused [redacted]; timed out');
    });

    it('keeps its own message when it has one', () => {
      const original = new AggregateError([new Error('inner')], 'every address failed');

      expect(redactedError('Delivery failed', original, []).message).toBe(
        'Delivery failed: every address failed',
      );
    });

    it('reads an aggregate inside the cause chain the same way', () => {
      const aggregate = withProps(new AggregateError([new Error('a'), new Error('b')]), {
        code: 'ECONNREFUSED',
      });
      const original = new TypeError('fetch failed', { cause: aggregate });

      const error = redactedError('Slack webhook request failed', original, []);

      expect(error.message).toBe('Slack webhook request failed: fetch failed (ECONNREFUSED)');
      expect((error.cause as Error).message).toBe('a; b');
      expect(error.code).toBe('ECONNREFUSED');
    });

    it('flattens a nested aggregate and leaves out an inner error with no message', () => {
      const original = new AggregateError([
        new AggregateError([new Error('deep one'), new Error('')]),
        'plain text',
      ]);

      expect(redactedError('Delivery failed', original, []).message).toBe(
        'Delivery failed: deep one; plain text',
      );
    });

    it('names just the prefix when nothing is left to say', () => {
      expect(redactedError('SMTP delivery failed', new AggregateError([]), []).message).toBe(
        'SMTP delivery failed',
      );
    });
  });
});

describe('DeliveryError', () => {
  it('is an Error named DeliveryError that carries only what it was given', () => {
    const error = new DeliveryError('Slack webhook answered HTTP 503', { status: 503 });

    expect(error).toBeInstanceOf(Error);
    expect(error.name).toBe('DeliveryError');
    expect(error.status).toBe(503);
    expect(error.code).toBeUndefined();
    expect(error.cause).toBeUndefined();
  });
});
