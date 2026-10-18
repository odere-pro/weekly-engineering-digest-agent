import { describe, expect, it } from 'vitest';
import { canonicalDigestText } from '../render/canonical';
import { buildJudgeState } from './judgePrompt';
import { UNTRUSTED_DATA_RULE } from '../shared/untrusted';
import { makeDraft, makeItem } from '../../test/builders';

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
