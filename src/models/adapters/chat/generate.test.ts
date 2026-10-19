import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { PROFILES } from '../../../config/profiles';
import {
  BASE_URL,
  chatOk,
  fakeContext,
  hang,
  json,
  ndjson,
  sequence,
  WRITE,
} from '../__fixtures__/ollamaHarness';
import { generate } from './generate';

describe('generate', () => {
  it('posts a streamed chat for the role model with system and user messages', async () => {
    const { context, calls } = fakeContext(sequence(chatOk));

    await generate(context, WRITE);

    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe(`${BASE_URL}/api/chat`);
    expect(calls[0]!.method).toBe('POST');
    expect(calls[0]!.body).toEqual({
      model: 'gemma4:e4b-mlx',
      messages: [
        { role: 'system', content: 'You write digests.' },
        { role: 'user', content: 'Summarize.' },
      ],
      stream: true,
      options: { temperature: 0.2 },
    });
  });

  it('uses an explicit writer model, the JSON schema as format and the temperature', async () => {
    const { context, calls } = fakeContext(sequence(chatOk));
    const jsonSchema = { type: 'object', properties: { title: { type: 'string' } } };

    const result = await generate(context, {
      ...WRITE,
      model: 'nemotron-3.5-lightning:30b-mlx',
      jsonSchema,
      temperature: 0.2,
    });

    expect(calls[0]!.body).toMatchObject({
      model: 'nemotron-3.5-lightning:30b-mlx',
      stream: true,
      format: jsonSchema,
      options: { temperature: 0.2 },
    });
    expect(result.model).toBe('nemotron-3.5-lightning:30b-mlx');
  });

  it('resolves the first model of the role from the profile', async () => {
    const { context, calls } = fakeContext(sequence(chatOk), { profile: PROFILES.quality });
    await generate(context, { ...WRITE, role: 'judge' });
    expect(calls[0]!.body).toMatchObject({ model: 'clef:latest' });
  });

  it('maps the reply text, token counts and latency', async () => {
    const { context } = fakeContext(sequence(chatOk));

    const result = await generate(context, WRITE);

    expect(result).toMatchObject({
      model: 'gemma4:e4b-mlx',
      text: '{"title":"vLLM 0.12 adds speculative decoding"}',
      usage: { inputTokens: 42, outputTokens: 9 },
    });
    expect(result.latencyMs).toBeGreaterThanOrEqual(0);
  });

  it('counts missing token fields as zero', async () => {
    const { context } = fakeContext(
      sequence(() => ndjson({ message: { content: 'hi' }, done: true })),
    );
    const result = await generate(context, WRITE);
    expect(result.usage).toEqual({ inputTokens: 0, outputTokens: 0 });
  });

  it('logs one line per call with role, model, latency and tokens', async () => {
    const { context, lines } = fakeContext(sequence(chatOk));

    await generate(context, WRITE);

    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({
      level: 'info',
      fields: {
        role: 'write',
        model: 'gemma4:e4b-mlx',
        op: 'generate',
        inputTokens: 42,
        outputTokens: 9,
        attempts: 1,
      },
    });
    expect(lines[0]!.fields.latencyMs).toEqual(expect.any(Number));
  });

  it('fails clearly when the profile has no model for the role', async () => {
    const { context, calls } = fakeContext(sequence(chatOk));
    await expect(generate(context, { ...WRITE, role: 'judge' })).rejects.toThrow(
      'No model is configured for role judge in profile light',
    );
    expect(calls).toHaveLength(0);
  });

  it('rejects a stream line that does not match the chat shape', async () => {
    const { context, calls } = fakeContext(sequence(() => ndjson({ done: 'yes' })));
    await expect(generate(context, WRITE)).rejects.toThrow(/unexpected \/api\/chat response/);
    expect(calls).toHaveLength(1);
  });

  it('rejects a stream that ends before the reply is done', async () => {
    const { context } = fakeContext(
      sequence(() => ndjson({ message: { content: 'half' }, done: false })),
    );
    await expect(generate(context, WRITE)).rejects.toThrow(
      'Ollama ended the /api/chat stream before the reply was done',
    );
  });

  it('rejects a body that is not JSON without retrying', async () => {
    const { context, calls } = fakeContext(sequence(() => new Response('<html>proxy</html>')));
    await expect(generate(context, WRITE)).rejects.toThrow(
      'Ollama returned a non-JSON /api/chat response: <html>proxy</html>',
    );
    expect(calls).toHaveLength(1);
  });

  it('passes the caller’s abort through without a second request', async () => {
    const controller = new AbortController();
    const reason = new Error('run cancelled');
    controller.abort(reason);
    const { context, calls } = fakeContext((call) => hang(call.signal));

    await expect(generate(context, { ...WRITE, signal: controller.signal })).rejects.toBe(reason);
    expect(calls).toHaveLength(1);
  });

  it('fails with the Ollama error when the request is rejected', async () => {
    const { context, calls } = fakeContext(
      sequence(() => json(400, { error: 'bad request' })),
      { retries: 0 },
    );
    await expect(generate(context, WRITE)).rejects.toThrow(
      'Ollama generate call to gemma4:e4b-mlx failed: Ollama returned 400 for /api/chat: bad request',
    );
    expect(calls).toHaveLength(1);
  });
});

describe('generate: a reply cut at the token limit', () => {
  const SCHEMA = z.object({ headline: z.string(), items: z.array(z.string()) });
  const COMPLETE = '{"headline":"Week 42","items":["a","b"]}';
  const cutReply = (): Response =>
    ndjson({ message: { content: COMPLETE.slice(0, 25) }, done: true, done_reason: 'length' });

  it('is returned as it is, with a warning', async () => {
    const { context, lines } = fakeContext(sequence(cutReply));

    const result = await generate(context, WRITE);

    expect(result.text).toBe(COMPLETE.slice(0, 25));
    expect(lines).toContainEqual(
      expect.objectContaining({
        level: 'warn',
        message: 'ollama reply hit the token limit',
        fields: expect.objectContaining({
          role: 'write',
          model: 'gemma4:e4b-mlx',
          outputTokens: 0,
          structured: false,
        }) as unknown,
      }),
    );
  });

  it('is logged as an incomplete structured reply when a schema was requested', async () => {
    const { context, lines } = fakeContext(sequence(cutReply));

    await generate(context, { ...WRITE, jsonSchema: z.toJSONSchema(SCHEMA) });

    expect(lines).toContainEqual(
      expect.objectContaining({
        level: 'warn',
        message: 'ollama reply hit the token limit',
        fields: expect.objectContaining({ structured: true }) as unknown,
      }),
    );
  });

  it('is not warned about when the reply stopped on its own', async () => {
    const { context, lines } = fakeContext(sequence(chatOk));

    await generate(context, WRITE);

    expect(lines.filter((line) => line.level === 'warn')).toEqual([]);
  });
});
