import { z } from 'zod';
import { describe, expect, it } from 'vitest';
import { describeIssues } from './describeIssues';

function errorOf(schema: z.ZodType, value: unknown): z.ZodError {
  const result = schema.safeParse(value);
  if (result.success) throw new Error('the value was valid');
  return result.error;
}

describe('describeIssues', () => {
  it('puts the path of the field before its message', () => {
    const schema = z.object({ schedule: z.object({ timeZone: z.string() }) });

    const text = describeIssues(errorOf(schema, { schedule: { timeZone: 3 } }));

    expect(text).toMatch(/^schedule\.timeZone: /);
  });

  it('prints only the message when the value itself is wrong', () => {
    const text = describeIssues(errorOf(z.string().min(3, 'too short'), 'ab'));

    expect(text).toBe('too short');
  });

  it('lists every issue on its own line', () => {
    const schema = z.object({ a: z.string(), b: z.number() });

    const lines = describeIssues(errorOf(schema, {})).split('\n');

    expect(lines).toHaveLength(2);
    expect(lines[0]).toMatch(/^a: /);
    expect(lines[1]).toMatch(/^b: /);
  });
});
