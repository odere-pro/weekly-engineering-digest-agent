// Live check that the default `think: false` for guardRisk keeps granite4.1-guardian short.
// Lane gpu: run alone, with `LIVE_OLLAMA=1 pnpm vitest run test/live/think.live.test.ts`.
import { describe, expect, it } from 'vitest';
import { GRANITE_CRITERIA, parseGraniteScore } from '../../src/guards/adapters/granite';
import { createOllamaProvider } from '../../src/models/adapters/ollama';
import { MODEL_TAGS, PROFILES } from '../../src/config/profiles';
import { noopLogger } from '../../src/shared/telemetry';
import { UNTRUSTED_DATA_RULE, wrapUntrusted } from '../../src/shared/untrusted';

const BASE_URL = process.env.OLLAMA_URL ?? 'http://127.0.0.1:11434';
const LIVE_TIMEOUT_MS = 300_000;
/** The answer is `<score>no</score>`; with thinking on the same call wrote 330-357 tokens. */
const MAX_OUTPUT_TOKENS_WITHOUT_THINKING = 100;

describe.skipIf(process.env.LIVE_OLLAMA !== '1')('Ollama think setting (live)', () => {
  it(
    'answers a guardRisk call with a score and no reasoning block by default',
    async () => {
      const provider = createOllamaProvider({
        baseUrl: BASE_URL,
        profile: PROFILES.quality,
        logger: noopLogger,
      });

      const result = await provider.generate({
        role: 'guardRisk',
        system: `${GRANITE_CRITERIA.jailbreak}\n\n${UNTRUSTED_DATA_RULE}`,
        prompt: wrapUntrusted(
          'live-think',
          'vLLM v0.12.0 adds speculative decoding and cuts p99 latency by 30%.',
        ),
        temperature: 0,
      });

      process.stdout.write(
        `think live: model=${result.model} outputTokens=${result.usage.outputTokens} latencyMs=${result.latencyMs}\n`,
      );
      expect(result.model).toBe(MODEL_TAGS.graniteGuardian);
      expect(parseGraniteScore(result.text)).toBe('no');
      expect(result.text).not.toContain('<think>');
      expect(result.usage.outputTokens).toBeLessThan(MAX_OUTPUT_TOKENS_WITHOUT_THINKING);
    },
    LIVE_TIMEOUT_MS,
  );
});
