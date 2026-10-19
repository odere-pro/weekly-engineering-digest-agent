import { describe, expect, it } from 'vitest';
import type { GenerateRequest } from '../../ModelProvider';
import { chatBody } from './chatBody';

const REQUEST: GenerateRequest = {
  role: 'write',
  system: 'You write digests.',
  prompt: 'Summarize.',
};
const SAMPLING = { temperature: 0.2, seed: undefined };

describe('chatBody', () => {
  it('builds a streamed chat with the system and user messages and the default sampling', () => {
    expect(chatBody('gemma4:e4b-mlx', REQUEST, undefined, SAMPLING)).toEqual({
      model: 'gemma4:e4b-mlx',
      messages: [
        { role: 'system', content: 'You write digests.' },
        { role: 'user', content: 'Summarize.' },
      ],
      stream: true,
      options: { temperature: 0.2 },
    });
  });

  it('leaves think out when there is no setting and sends false as it is', () => {
    expect(chatBody('m', REQUEST, undefined, SAMPLING)).not.toHaveProperty('think');
    expect(chatBody('m', REQUEST, false, SAMPLING)).toMatchObject({ think: false });
    expect(chatBody('m', REQUEST, 'low', SAMPLING)).toMatchObject({ think: 'low' });
  });

  it('sends the JSON schema as the format, and no format without one', () => {
    const jsonSchema = { type: 'object', properties: { title: { type: 'string' } } };

    expect(chatBody('m', { ...REQUEST, jsonSchema }, undefined, SAMPLING)).toMatchObject({
      format: jsonSchema,
    });
    expect(chatBody('m', REQUEST, undefined, SAMPLING)).not.toHaveProperty('format');
  });

  it('lets the request temperature win over the sampling one, including 0', () => {
    const body = chatBody('m', { ...REQUEST, temperature: 0 }, undefined, SAMPLING);

    expect(body.options).toEqual({ temperature: 0 });
  });

  it('sends the sampling seed when the request has none, and the request seed when it has', () => {
    const sampling = { temperature: 0.2, seed: 42 };

    expect(chatBody('m', REQUEST, undefined, sampling).options).toEqual({
      temperature: 0.2,
      seed: 42,
    });
    expect(chatBody('m', { ...REQUEST, seed: 5 }, undefined, sampling).options).toEqual({
      temperature: 0.2,
      seed: 5,
    });
  });

  it('sends a seed of 0 as it is', () => {
    expect(chatBody('m', { ...REQUEST, seed: 0 }, undefined, SAMPLING).options).toEqual({
      temperature: 0.2,
      seed: 0,
    });
  });

  it('sends no seed when neither the request nor the sampling has one', () => {
    expect(chatBody('m', REQUEST, undefined, SAMPLING).options).not.toHaveProperty('seed');
  });
});
