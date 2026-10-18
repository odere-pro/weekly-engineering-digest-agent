// Live checks against the local Ollama. Lane gpu: run alone, with `LIVE_OLLAMA=1 pnpm vitest run test/live`.
import { describe, expect, it } from 'vitest';
import { createOllamaProvider } from '../../src/models/adapters/ollama';
import { PROFILES } from '../../src/config/profiles';
import { noopLogger } from '../../src/shared/telemetry';

const BASE_URL = process.env.OLLAMA_URL ?? 'http://127.0.0.1:11434';
const LIVE_TIMEOUT_MS = 300_000;

describe.skipIf(process.env.LIVE_OLLAMA !== '1')('Ollama provider (live)', () => {
  it(
    'answers every decision question type on clef',
    async () => {
      const provider = createOllamaProvider({
        baseUrl: BASE_URL,
        profile: PROFILES.quality,
        logger: noopLogger,
      });

      const result = await provider.decide({
        role: 'classify',
        state: 'Release: vLLM v0.12.0 adds speculative decoding and cuts p99 latency by 30%.',
        questions: {
          hype: { type: 'yesno', instructions: 'Is this release note mostly marketing hype?' },
          area: {
            type: 'choice',
            instructions: 'Which engineering area does this release belong to?',
            options: { inference: 'model serving', training: null },
          },
          relevance: {
            type: 'score',
            instructions: 'How relevant is this to an AI platform engineer?',
            levels: ['low', 'medium', 'high'],
          },
        },
      });

      expect(result.model).toBe('clef:latest');
      expect(result.answers.hype).toMatchObject({ type: 'yesno' });
      expect(result.answers.area).toMatchObject({ type: 'choice', choice: 'inference' });
      expect(result.answers.relevance).toMatchObject({ type: 'score' });
      expect(result.usage.inputTokens).toBeGreaterThan(0);
    },
    LIVE_TIMEOUT_MS,
  );

  it(
    'answers a yes/no question on strands-decider with a long trimmed state',
    async () => {
      const provider = createOllamaProvider({
        baseUrl: BASE_URL,
        profile: PROFILES.light,
        logger: noopLogger,
      });

      const result = await provider.decide({
        role: 'classify',
        state: `Patch release fixing a typo in the README. ${'Changelog line. '.repeat(1_000)}`,
        questions: { minor: { type: 'yesno', instructions: 'Is this a minor release?' } },
      });

      expect(result.model).toBe('strands-decider:2b-mlx-bf16');
      expect(result.answers.minor).toMatchObject({ type: 'yesno' });
    },
    LIVE_TIMEOUT_MS,
  );

  it(
    'generates a tiny reply on gemma4:e4b-mlx',
    async () => {
      const provider = createOllamaProvider({
        baseUrl: BASE_URL,
        profile: PROFILES.light,
        logger: noopLogger,
      });

      const result = await provider.generate({
        role: 'write',
        model: 'gemma4:e4b-mlx',
        system: 'Answer with one word.',
        prompt: 'Say ok.',
        temperature: 0,
      });

      expect(result.text.trim().length).toBeGreaterThan(0);
      expect(result.usage.outputTokens).toBeGreaterThan(0);
    },
    LIVE_TIMEOUT_MS,
  );

  it('reports the installed models', async () => {
    const provider = createOllamaProvider({
      baseUrl: BASE_URL,
      profile: PROFILES.quality,
      logger: noopLogger,
    });
    const health = await provider.health();
    expect(health.reachable).toBe(true);
    expect(health.models.map((m) => m.name)).toContain('clef:latest');
  });
});
