import { describe, expect, it } from 'vitest';
import type { DigestView } from '../../../render/digestView';
import { toSlackBlocks } from './toSlackBlocks';

const BLOCK_LIMIT = 50;
const base: DigestView = {
  weekId: '2026-W42',
  title: 'Week 2026-W42: 1 release, nothing needs action',
  headline: 'Quiet.',
  groups: [
    {
      urgency: 'good-to-know',
      label: 'Good to know',
      items: [{ title: 'Ollama', url: 'https://e.test/o', whatChanged: 'Faster.' }],
    },
  ],
};
const appendixOf = (areas: number, perArea: number): DigestView['appendix'] => ({
  title: 'Everything this week',
  groups: Array.from({ length: areas }, (_, a) => ({
    area: `Area ${String(a)}`,
    items: Array.from({ length: perArea }, (_, i) => ({
      title: `Release ${String(a)}-${String(i)}`,
      url: `https://e.test/${String(a)}/${String(i)}`,
      line: 'A line of the item.',
    })),
  })),
});

const header = (view: DigestView): string => {
  const first = toSlackBlocks(view).blocks[0];
  return first?.type === 'header' ? first.text.text : '';
};

describe('Slack variant label and appendix', () => {
  it('suffixes the header only with a variant', () => {
    expect(header(base)).toBe(base.title);
    expect(header({ ...base, variant: 'perspective: security' })).toBe(
      `${base.title} (perspective: security)`,
    );
  });

  it('adds one section per area after the groups', () => {
    const blocks = toSlackBlocks({ ...base, appendix: appendixOf(3, 2) }).blocks;
    const texts = blocks.flatMap((b) => (b.type === 'section' ? [b.text.text] : []));

    expect(texts.filter((t) => t.startsWith('*Area '))).toHaveLength(3);
    expect(JSON.stringify(blocks)).toContain('*Everything this week*');
  });

  it('stays within the block cap with a 40-item appendix', () => {
    const { blocks } = toSlackBlocks({
      ...base,
      footer: 'Footer',
      appendix: appendixOf(40, 1),
    });

    expect(blocks.length).toBeLessThanOrEqual(BLOCK_LIMIT);
    expect(blocks.at(-1)).toMatchObject({ type: 'context' });
  });

  it('escapes appendix text so it cannot ping a channel', () => {
    const view: DigestView = {
      ...base,
      appendix: {
        title: 'Everything this week',
        groups: [{ area: '<!channel>', items: [{ title: '<@U1>', url: 'x', line: '<!here>' }] }],
      },
    };

    const json = JSON.stringify(toSlackBlocks(view).blocks);

    expect(json).not.toMatch(/<[!@]/);
    expect(json).toContain('&lt;!channel&gt;');
  });
});
