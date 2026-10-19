import { describe, expect, it } from 'vitest';
import { DigestError } from '../../../shared/errors';
import { MODEL_TAGS } from '../../../config/profiles';
import { chatOk, fakeContext, json, ndjson, sequence, WRITE } from '../__fixtures__/ollamaHarness';
import { effectiveThink } from './chatSettings';
import { generate } from './generate';

describe('generate: sampling', () => {
  it.each([
    ['write', 0.2],
    ['classify', 0],
    ['guardPolicy', 0],
    ['guardRisk', 0],
    ['judge', 0],
  ] as const)('defaults the %s temperature to %s', async (role, temperature) => {
    const { context, calls } = fakeContext(sequence(chatOk));

    await generate(context, { role, system: 's', prompt: 'p', model: 'any:model' });

    expect((calls[0]!.body as { options: unknown }).options).toEqual({ temperature });
  });

  it('sends the provider seed when the request has none', async () => {
    const { context, calls } = fakeContext(sequence(chatOk), { seed: 42 });

    await generate(context, WRITE);

    expect(calls[0]!.body).toMatchObject({ options: { seed: 42, temperature: 0.2 } });
  });

  it('sends no seed when none is set anywhere', async () => {
    const { context, calls } = fakeContext(sequence(chatOk));

    await generate(context, WRITE);

    expect((calls[0]!.body as { options: object }).options).not.toHaveProperty('seed');
  });

  it('lets the request seed and temperature win, including a temperature of 0', async () => {
    const { context, calls } = fakeContext(sequence(chatOk), {
      seed: 42,
      temperature: { write: 0.9 },
    });

    await generate(context, { ...WRITE, seed: 5, temperature: 0 });

    expect(calls[0]!.body).toMatchObject({ options: { seed: 5, temperature: 0 } });
  });

  it('applies a configured per-role temperature over the default', async () => {
    const { context, calls } = fakeContext(sequence(chatOk), { temperature: { write: 0.7 } });

    await generate(context, WRITE);

    expect(calls[0]!.body).toMatchObject({ options: { temperature: 0.7 } });
  });
});

describe('generate: think', () => {
  const GUARD = { role: 'guardRisk', system: 'Judge the text.', prompt: 'Text.' } as const;

  it('sends what effectiveThink says for each role', async () => {
    const think = { classify: 'medium', guardRisk: true } as const;
    const { context, calls } = fakeContext(sequence(chatOk), { think });

    await generate(context, { role: 'classify', system: 's', prompt: 'p' });
    await generate(context, { role: 'guardRisk', system: 's', prompt: 'p' });

    expect(calls.map((call) => (call.body as { think?: unknown }).think)).toEqual(
      (['classify', 'guardRisk'] as const).map((role) => effectiveThink(think, role)),
    );
  });

  it('defaults guardRisk to think false', async () => {
    const { context, calls } = fakeContext(sequence(chatOk));

    await generate(context, GUARD);

    expect(calls[0]!.body).toMatchObject({ model: MODEL_TAGS.graniteGuardian, think: false });
  });

  it('sends no think field for a role without a setting', async () => {
    const { context, calls } = fakeContext(sequence(chatOk));

    await generate(context, WRITE);

    expect(calls[0]!.body).not.toHaveProperty('think');
  });

  it('sends an override for a role as given', async () => {
    const { context, calls } = fakeContext(sequence(chatOk), { think: { write: 'low' } });

    await generate(context, WRITE);

    expect(calls[0]!.body).toMatchObject({ think: 'low' });
  });

  it('lets an override turn guardRisk thinking on', async () => {
    const { context, calls } = fakeContext(sequence(chatOk), { think: { guardRisk: true } });

    await generate(context, GUARD);

    expect(calls[0]!.body).toMatchObject({ think: true });
  });

  it('keeps the guardRisk default when only another role is overridden', async () => {
    const { context, calls } = fakeContext(sequence(chatOk), { think: { write: 'high' } });

    await generate(context, GUARD);

    expect(calls[0]!.body).toMatchObject({ think: false });
  });

  it('sends an explicit false for a role that has no default', async () => {
    const { context, calls } = fakeContext(sequence(chatOk), { think: { write: false } });

    await generate(context, WRITE);

    expect(calls[0]!.body).toMatchObject({ think: false });
  });

  it('logs the effective think setting, or default when the role has none', async () => {
    const { context, lines } = fakeContext(sequence(chatOk), { think: { write: 'medium' } });

    await generate(context, GUARD);
    await generate(context, WRITE);
    await generate(context, { ...WRITE, role: 'classify' });

    const calls = lines.filter((l) => l.message === 'ollama call');
    expect(calls.map((l) => l.fields.think)).toEqual([false, 'medium', 'default']);
  });

  it('logs the think setting on failure and token-limit lines too', async () => {
    const failing = fakeContext(
      sequence(() => json(400, { error: 'bad request' })),
      { retries: 0 },
    );
    await expect(generate(failing.context, GUARD)).rejects.toThrow(DigestError);
    expect(failing.lines.at(-1)).toMatchObject({ level: 'error', fields: { think: false } });

    const cut = fakeContext(
      sequence(() => ndjson({ message: { content: 'cut' }, done: true, done_reason: 'length' })),
      { think: { write: 'high' } },
    );
    await generate(cut.context, WRITE);
    expect(cut.lines).toContainEqual(
      expect.objectContaining({
        message: 'ollama reply hit the token limit',
        fields: expect.objectContaining({ think: 'high' }) as unknown,
      }),
    );
  });
});
