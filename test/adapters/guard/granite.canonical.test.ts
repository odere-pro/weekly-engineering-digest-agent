// The groundedness calls take their text from the canonical helpers, never from the Markdown
// renderer (W7-04). The bytes sent stay those of W5-11, so the recorded replies still apply.
import { describe, expect, it } from 'vitest';
import { createGraniteGroundednessGuard } from '../../../src/adapters/guard/granite.js';
import { canonicalClaimText, canonicalHeadlineText } from '../../../src/core/canonical.js';
import { DATA_CLOSE } from '../../../src/shared/untrusted.js';
import { makeDraft, makeItem } from '../../builders.js';
import { FakeModelProvider } from '../../fakes/FakeModelProvider.js';

const first = makeItem({ title: 'vLLM 0.12', summary: 'Adds speculative decoding.' });
const second = makeItem({ title: 'KServe 0.15', summary: 'Adds an inference graph.' });
const draft = makeDraft([first, second], 'w', { headline: 'Fast week', intro: 'Two releases.' });

async function prompts(): Promise<string[]> {
  const model = new FakeModelProvider({ generate: () => '<score>no</score>' });
  await createGraniteGroundednessGuard({ model }).checkDraft(draft, [first, second]);
  return model.generateCalls.map((call) => call.prompt);
}

const textBlock = (prompt: string): string =>
  prompt.slice(prompt.indexOf('Text to check:')).split('>>>\n')[1]!.split(`\n${DATA_CLOSE}`)[0]!;

describe('canonical groundedness input', () => {
  it('checks each item as its claim text', async () => {
    const [firstCall, secondCall] = await prompts();

    expect(textBlock(firstCall!)).toBe(canonicalClaimText(draft.digest.items[0]!));
    expect(textBlock(secondCall!)).toBe(canonicalClaimText(draft.digest.items[1]!));
  });

  it('checks the headline and intro as the canonical headline text', async () => {
    const all = await prompts();

    expect(textBlock(all[2]!)).toBe(canonicalHeadlineText(draft.digest));
    expect(all.join('\n')).not.toContain('## 1.');
  });
});
