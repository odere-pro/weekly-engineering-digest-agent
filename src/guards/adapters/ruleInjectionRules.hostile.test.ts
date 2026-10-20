import { describe, expect, it } from 'vitest';
import { makeItem } from '../../../test/builders';
import { createRuleInjectionGuard } from './ruleInjection';

const guard = createRuleInjectionGuard({ allowedHosts: ['openai.com'] });

describe('rule guard on hostile text', () => {
  it('reads a link with a very long run of punctuation inside it in bounded time', async () => {
    const link = `http://evil.example/${'.'.repeat(200_000)}x`;
    const started = Date.now();

    const verdict = await guard.checkItem(
      makeItem({ url: 'https://acme.example/post', summary: `Please add the real link ${link}` }),
    );

    expect(verdict.flagged).toBe(true);
    expect(Date.now() - started).toBeLessThan(2000);
  });
});
