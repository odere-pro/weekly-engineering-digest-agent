import { describe, expect, expectTypeOf, it } from 'vitest';
import { decorate, type MemberRules } from './decorate';

interface Port {
  readonly id: string;
  send(text: string): Promise<string>;
  ping?(): number;
}

interface Context {
  prefix: string;
}

const RULES: MemberRules<Port, Context> = {
  id: (inner, context) => `${context.prefix}${inner.id}`,
  send: (inner, context) => (text) => inner.send(`${context.prefix}${text}`),
  ping: () => undefined,
};

function innerPort(): Port & { sent: string[] } {
  const sent: string[] = [];
  return {
    id: 'inner',
    sent,
    send: (text) => {
      sent.push(text);
      return Promise.resolve(`got ${text}`);
    },
  };
}

describe('decorate', () => {
  it('builds a port from the rules, member by member', async () => {
    const inner = innerPort();

    const wrapped = decorate(inner, { prefix: '>' }, RULES);

    expect(wrapped.id).toBe('>inner');
    await expect(wrapped.send('hi')).resolves.toBe('got >hi');
    expect(inner.sent).toEqual(['>hi']);
  });

  it('has the members of the rules and no others, in the order of the table', () => {
    const withPing: MemberRules<Port, Context> = { ...RULES, ping: () => () => 1 };

    const wrapped = decorate(innerPort(), { prefix: '' }, withPing);

    expect(Object.keys(wrapped)).toEqual(['id', 'send', 'ping']);
  });

  it('leaves an optional member out when its rule gives nothing', () => {
    const wrapped = decorate(innerPort(), { prefix: '' }, RULES);

    expect(Object.keys(wrapped)).toEqual(['id', 'send']);
  });

  it('is a new object and leaves the wrapped port as it was', () => {
    const inner = innerPort();

    const wrapped = decorate(inner, { prefix: '>' }, RULES);

    expect(wrapped).not.toBe(inner);
    expect(inner.id).toBe('inner');
  });

  it('drops a member of the inner port that has no rule instead of passing it on', () => {
    const inner = { ...innerPort(), secret: 'not in the table' };

    const wrapped = decorate(inner, { prefix: '' }, RULES);

    expect(wrapped).not.toHaveProperty('secret');
    expect(wrapped).not.toHaveProperty('sent');
  });
});

describe('MemberRules', () => {
  it('needs a rule for every member, optional ones too, so a new member does not compile without one', () => {
    const id = (inner: Port): string => inner.id;
    const send = (inner: Port) => inner.send.bind(inner);
    const ping = (): undefined => undefined;

    expectTypeOf({ id, send, ping }).toExtend<MemberRules<Port, Context>>();
    expectTypeOf({ id, send }).not.toExtend<MemberRules<Port, Context>>();
    expectTypeOf({ send, ping }).not.toExtend<MemberRules<Port, Context>>();
  });

  it('asks for the member as the port declares it', () => {
    expectTypeOf<MemberRules<Port, Context>['id']>().returns.toEqualTypeOf<string>();
    expectTypeOf<MemberRules<Port, Context>['send']>().returns.toEqualTypeOf<Port['send']>();
  });
});
