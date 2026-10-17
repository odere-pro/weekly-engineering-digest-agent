import { describe, expect, it } from 'vitest';
import { canonicalDigestText } from '../../../src/core/canonical.js';
import { buildJudgeState } from '../../../src/core/prompts/judge.js';
import { UNTRUSTED_DATA_RULE } from '../../../src/shared/untrusted.js';
import { makeDraft, makeItem } from '../../builders.js';

describe('buildJudgeState', () => {
  const item = makeItem();
  const draft = makeDraft([item]);
  const state = buildJudgeState(draft, [item]);

  it('shows the canonical digest text, not Markdown', () => {
    expect(state).toContain(canonicalDigestText(draft.digest));
    expect(state).not.toContain('## 1.');
    expect(state).not.toContain('[Source](');
  });

  it('keeps the data rule and wraps the draft and each source', () => {
    expect(state.startsWith(UNTRUSTED_DATA_RULE)).toBe(true);
    expect(state).toContain('draft');
    expect(state).toContain(`source:${item.id}`);
  });
});
