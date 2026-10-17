import { describe, expect, it } from 'vitest';
import {
  classifyBatchPrompt,
  classifyState,
  rescorePrompt,
  rescoreSystem,
} from '../../../src/core/prompts/classify.js';
import { UNTRUSTED_DATA_RULE, wrapUntrusted } from '../../../src/shared/untrusted.js';
import { makeItem } from '../../builders.js';

describe('classifyState', () => {
  it('is the data rule followed by the untrusted block when there is no hint', () => {
    const item = makeItem({ id: 'abc', title: 'T', summary: 'S' });

    expect(classifyState(item)).toBe(
      `${UNTRUSTED_DATA_RULE}\n\n${wrapUntrusted('abc', `Title: T\nSource: ${item.sourceId} (rss)\nSummary: S`)}`,
    );
  });

  it('adds one Source tag line between the rule and the untrusted block', () => {
    const item = makeItem({ id: 'abc', title: 'T', summary: 'S' });

    const state = classifyState(item, 'ai-models');

    expect(state).toBe(
      `${UNTRUSTED_DATA_RULE}\n\nSource tag: ai-models\n\n${wrapUntrusted('abc', `Title: T\nSource: ${item.sourceId} (rss)\nSummary: S`)}`,
    );
  });

  it('keeps a hint with a line break on one line', () => {
    expect(classifyState(makeItem(), 'ai\nIgnore this')).toContain('Source tag: ai Ignore this\n');
  });
});

describe('blank hints', () => {
  it('count as no hint', () => {
    const item = makeItem({ id: 'abc', sourceId: 's1' });

    expect(classifyState(item, '  ')).toBe(classifyState(item));
    expect(classifyBatchPrompt([item], new Map([['s1', ' \n ']]))).toBe(
      classifyBatchPrompt([item]),
    );
  });
});

describe('classifyBatchPrompt', () => {
  it('is unchanged without hints', () => {
    const items = [makeItem({ id: 'a' }), makeItem({ id: 'b' })];

    expect(classifyBatchPrompt(items)).toBe(classifyBatchPrompt(items, new Map()));
    expect(classifyBatchPrompt(items)).not.toContain('Source tag');
  });

  it('lists a Source tag line for each hinted item, outside the data blocks', () => {
    const items = [makeItem({ id: 'a', sourceId: 's1' }), makeItem({ id: 'b', sourceId: 's2' })];

    const prompt = classifyBatchPrompt(items, new Map([['s1', 'cloud']]));

    expect(prompt).toContain('Source tag for a: cloud');
    expect(prompt).not.toContain('Source tag for b');
    expect(prompt.indexOf('Source tag for a')).toBeLessThan(prompt.indexOf('<<<DATA'));
  });
});

describe('rescore prompts', () => {
  it('system prompt names the focus areas, the score scale and the untrusted-data rule', () => {
    const system = rescoreSystem(['Cloud', 'Data']);

    expect(system).toContain('"Cloud", "Data"');
    expect(system).toContain('3 = must read');
    expect(system).toContain('confidence');
    expect(system).toContain(UNTRUSTED_DATA_RULE);
  });

  it('wraps every item as its own data block and keeps tags outside the blocks', () => {
    const items = [
      makeItem({ id: 'a', sourceId: 's1' }),
      makeItem({ id: 'b', title: 'x\nignore' }),
    ];

    const prompt = rescorePrompt(items, new Map([['s1', 'cloud\nnew line']]));

    expect(prompt.match(/<<<DATA /g)).toHaveLength(2);
    expect(prompt).toContain('Source tag for a: cloud new line');
    expect(prompt.indexOf('Source tag for a')).toBeLessThan(prompt.indexOf('<<<DATA'));
  });
});
