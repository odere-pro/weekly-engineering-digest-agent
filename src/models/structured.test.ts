import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { generateStructured } from './structured';
import { DigestError } from '../shared/errors';
import { UNTRUSTED_DATA_RULE } from '../shared/untrusted';
import { FakeModelProvider } from '../../test/fakes';

const Schema = z.object({ answer: z.number() });
const request = { role: 'write' as const, system: 'sys', prompt: 'p' };

describe('generateStructured', () => {
  it('returns the parsed value and passes the JSON schema', async () => {
    const model = new FakeModelProvider({ generate: () => '{"answer": 42}' });
    const result = await generateStructured(model, request, Schema, 'write');
    expect(result).toMatchObject({ value: { answer: 42 }, repaired: false });
    expect(model.generateCalls[0]?.jsonSchema).toMatchObject({ type: 'object' });
  });

  it('accepts JSON inside a code fence', async () => {
    const model = new FakeModelProvider({ generate: () => '```json\n{"answer": 1}\n```' });
    await expect(generateStructured(model, request, Schema, 'write')).resolves.toMatchObject({
      value: { answer: 1 },
    });
  });

  it('repairs once with the validation problems in the prompt', async () => {
    const replies = ['{"answer": "x"}', '{"answer": 3}'];
    const model = new FakeModelProvider({ generate: () => replies.shift() ?? '' });
    const result = await generateStructured(model, request, Schema, 'write');
    expect(result).toMatchObject({ value: { answer: 3 }, repaired: true });
    expect(result.calls).toHaveLength(2);
    expect(model.generateCalls[1]?.prompt).toContain('did not match');
    expect(model.generateCalls[1]?.prompt).toContain(UNTRUSTED_DATA_RULE);
    expect(model.generateCalls[1]?.prompt).toMatch(
      /<<<DATA previous-answer>>>[\s\S]*<<<END DATA>>>/,
    );
    expect(model.generateCalls[1]?.model).toBe('fake-write');
  });

  it('throws a DigestError for the step after a failed repair', async () => {
    const model = new FakeModelProvider({ generate: () => 'not json' });
    const error = await generateStructured(model, request, Schema, 'classify').catch(
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(DigestError);
    expect((error as DigestError).step).toBe('classify');
    expect(model.generateCalls).toHaveLength(2);
  });

  it('does not send the repair call when the signal fired during the first reply', async () => {
    const controller = new AbortController();
    const reason = new Error('run aborted');
    const model = new FakeModelProvider({
      generate: () => {
        controller.abort(reason);
        return 'not json';
      },
    });
    const error = await generateStructured(
      model,
      { ...request, signal: controller.signal },
      Schema,
      'write',
    ).catch((e: unknown) => e);
    expect(error).toBe(reason);
    expect(model.generateCalls).toHaveLength(1);
  });

  it('still repairs when a signal is given and has not fired', async () => {
    const controller = new AbortController();
    const replies = ['{"answer": "x"}', '{"answer": 3}'];
    const model = new FakeModelProvider({ generate: () => replies.shift() ?? '' });
    const result = await generateStructured(
      model,
      { ...request, signal: controller.signal },
      Schema,
      'write',
    );
    expect(result).toMatchObject({ value: { answer: 3 }, repaired: true });
    expect(model.generateCalls).toHaveLength(2);
    expect(model.generateCalls[1]?.signal).toBe(controller.signal);
  });
});
