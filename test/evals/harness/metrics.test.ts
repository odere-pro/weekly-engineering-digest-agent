import { describe, expect, it } from 'vitest';
import {
  GATES,
  JUDGE_AGREEMENT_MIN,
  assembleMetrics,
  attackHandling,
  classifierAccuracy,
  digestItemIds,
  evaluateGate,
  failedHardGates,
  formatCompliance,
  groundedness,
  guardFalseBlocks,
  judgeAgreement,
  linkValidity,
  mustExcludeLeaks,
  mustIncludeRecall,
  parseDigestMarkdown,
  runTime,
  selectionAgreement,
  stability,
  withCoverage,
  writerWinRate,
  writingQuality,
  type DigestSample,
  type Measurement,
} from '../../../evals/metrics.js';
import { METRIC_IDS, type Gate, type MetricId } from '../../../evals/schema.js';
import { renderDigest } from '../../../src/core/render.js';
import type { Item } from '../../../src/core/schemas.js';
import { makeDigest, makeItem } from '../../builders.js';

function makeItems(count: number): Item[] {
  return Array.from({ length: count }, () => makeItem());
}

function sampleFor(items: readonly Item[], digestItems: readonly Item[] = items): DigestSample {
  const markdown = renderDigest(makeDigest(digestItems), { disabledGuards: [] });
  return { weekId: '2026-W42', markdown, items };
}

describe('parseDigestMarkdown', () => {
  it('reads back what renderDigest wrote', () => {
    const items = makeItems(3);
    const digest = makeDigest(items);
    const markdown = renderDigest(digest, { disabledGuards: ['clefRubric'] });

    const parsed = parseDigestMarkdown(markdown, digest.weekId, items);

    expect(parsed.headline).toBe(digest.headline);
    expect(parsed.intro).toBe(digest.intro);
    expect(parsed.items.map((i) => i.itemId)).toEqual(items.map((i) => i.id));
    expect(parsed.items.map((i) => i.title)).toEqual(digest.items.map((i) => i.title));
    expect(parsed.items.map((i) => i.summary)).toEqual(digest.items.map((i) => i.summary));
    expect(parsed.items.map((i) => i.whyItMatters)).toEqual(
      digest.items.map((i) => i.whyItMatters),
    );
    expect(parsed.items.map((i) => i.url)).toEqual(digest.items.map((i) => i.url));
  });

  it('does not mistake a rule line in a summary for the guards footer', () => {
    const items = makeItems(1);
    const markdown = [
      '# H',
      '_Week 2026-W42_',
      'Intro.',
      `## 1. T\n\nFirst paragraph.\n\n---\n\n**Why it matters:** Because.\n\n[Source](${items[0]?.url})`,
    ].join('\n\n');
    const parsed = parseDigestMarkdown(markdown, '2026-W42', items);
    expect(parsed.items[0]).toMatchObject({ whyItMatters: 'Because.', itemId: items[0]?.id });
  });

  it('keeps the last item clean when the guards footer follows it', () => {
    const items = makeItems(3);
    const markdown = renderDigest(makeDigest(items), { disabledGuards: ['clefRubric'] });
    const parsed = parseDigestMarkdown(markdown, '2026-W42', items);
    expect(parsed.items.at(-1)?.url).toBe(items[2]?.url);
    expect(parsed.items.at(-1)?.whyItMatters).toBe('It changes how teams build and run software.');
  });

  it('marks a link to an uncollected URL as unmatched', () => {
    const items = makeItems(1);
    const markdown =
      '# H\n\n_Week 2026-W42_\n\nIntro.\n\n## 1. T\n\nS.\n\n**Why it matters:** W.\n\n[Source](https://evil.example/x)\n';
    const parsed = parseDigestMarkdown(markdown, '2026-W42', items);
    expect(parsed.items[0]?.itemId).toBe('unmatched:https://evil.example/x');
  });

  it('yields empty sections for text that is not a digest', () => {
    const parsed = parseDigestMarkdown('just some words', '2026-W42', []);
    expect(parsed.headline).toBe('');
    expect(parsed.items).toEqual([]);
  });

  it('leaves the link empty when an item has no source link', () => {
    const markdown = '# H\n\nIntro.\n\n## 1. T\n\nS.\n';
    const parsed = parseDigestMarkdown(markdown, '2026-W42', []);
    expect(parsed.intro).toBe('Intro.');
    expect(parsed.items[0]).toMatchObject({ summary: 'S.', whyItMatters: '', url: '' });
  });
});

describe('digestItemIds', () => {
  it('maps digest links to collected item ids, ignoring URL tracking noise', () => {
    const [a, b] = makeItems(2) as [Item, Item];
    const markdown = renderDigest(makeDigest([{ ...a, url: `${a.url}?utm_source=x` }, b]), {
      disabledGuards: [],
    });
    expect(digestItemIds(markdown, [a, b])).toEqual([a.id, b.id]);
  });
});

describe('linkValidity', () => {
  it('is 1 when every digest only links to collected items', () => {
    const items = makeItems(4);
    expect(linkValidity([sampleFor(items), sampleFor(items)]).value).toBe(1);
  });

  it('drops when a digest links to a URL that was not collected', () => {
    const items = makeItems(4);
    const other = makeItem();
    const bad = sampleFor(items, [...items.slice(0, 3), other]);
    expect(linkValidity([sampleFor(items), bad]).value).toBe(0.5);
  });

  it('skips weeks without a digest and is null with none at all', () => {
    const items = makeItems(3);
    const none: DigestSample = { weekId: '2026-W41', markdown: undefined, items };
    expect(linkValidity([sampleFor(items), none]).value).toBe(1);
    expect(linkValidity([none]).value).toBeNull();
    expect(linkValidity([]).value).toBeNull();
  });
});

describe('formatCompliance', () => {
  it('is 1 when every digest has 3-5 items and no em dash', () => {
    expect(formatCompliance([sampleFor(makeItems(3)), sampleFor(makeItems(5))]).value).toBe(1);
  });

  it('fails a digest with too few or too many items', () => {
    const result = formatCompliance([
      sampleFor(makeItems(2)),
      sampleFor(makeItems(6)),
      sampleFor(makeItems(4)),
    ]);
    expect(result.value).toBeCloseTo(1 / 3);
  });

  it('fails a digest with an em dash', () => {
    const items = makeItems(3);
    const markdown = `${renderDigest(makeDigest(items), { disabledGuards: [] })}\nBig — news.\n`;
    expect(formatCompliance([{ weekId: '2026-W42', markdown, items }]).value).toBe(0);
  });

  it('counts a week without a digest as a failure', () => {
    const items = makeItems(3);
    const none: DigestSample = { weekId: '2026-W41', markdown: undefined, items };
    expect(formatCompliance([sampleFor(items), none]).value).toBe(0.5);
  });

  it('is null with no weeks', () => {
    expect(formatCompliance([]).value).toBeNull();
  });
});

describe('attackHandling', () => {
  it('is the share of attack items that stayed out of the digest', () => {
    const result = attackHandling([
      { caseId: 'a1', reachedDigest: false, evaluated: true, blockedBy: ['clefPolicy'] },
      {
        caseId: 'a2',
        reachedDigest: false,
        evaluated: true,
        blockedBy: ['clefPolicy', 'graniteRisk'],
      },
      { caseId: 'a3', reachedDigest: true, evaluated: true, blockedBy: [] },
      { caseId: 'a4', reachedDigest: false, evaluated: true, blockedBy: [] },
    ]);
    expect(result.value).toBe(0.75);
    expect(result.detail).toEqual({ clefPolicy: 2, graniteRisk: 1 });
  });

  it('does not credit an attack item that no guard saw', () => {
    const result = attackHandling([
      { caseId: 'a1', reachedDigest: false, evaluated: true, blockedBy: ['clefPolicy'] },
      { caseId: 'a2', reachedDigest: false, evaluated: false, blockedBy: [] },
    ]);
    expect(result.value).toBe(0.5);
  });

  it('is null without cases', () => {
    expect(attackHandling([]).value).toBeNull();
  });
});

describe('groundedness', () => {
  it('is the share of planted claims the output guards caught', () => {
    const result = groundedness([
      { caseId: 'g1', caught: true, flaggedBy: ['graniteGroundedness'] },
      { caseId: 'g2', caught: true, flaggedBy: ['graniteGroundedness', 'clefRubric'] },
      { caseId: 'g3', caught: false, flaggedBy: [] },
    ]);
    expect(result.value).toBeCloseTo(2 / 3);
    expect(result.detail).toEqual({ graniteGroundedness: 2, clefRubric: 1 });
  });

  it('is null without cases', () => {
    expect(groundedness([]).value).toBeNull();
  });
});

describe('guardFalseBlocks', () => {
  it('reports each guard and gates on the worst one', () => {
    const result = guardFalseBlocks({
      clefPolicy: { checked: 100, flagged: 2 },
      graniteRisk: { checked: 50, flagged: 5 },
    });
    expect(result.value).toBeCloseTo(0.1);
    expect(result.detail).toEqual({ clefPolicy: 0.02, graniteRisk: 0.1 });
  });

  it('ignores guards that checked nothing', () => {
    const result = guardFalseBlocks({
      clefPolicy: { checked: 0, flagged: 0 },
      graniteRisk: { checked: 10, flagged: 0 },
    });
    expect(result.value).toBe(0);
    expect(result.detail).toEqual({ graniteRisk: 0 });
  });

  it('is null when nothing was checked', () => {
    expect(guardFalseBlocks({}).value).toBeNull();
  });
});

describe('mustIncludeRecall', () => {
  it('averages the must-include items found in the digest per week', () => {
    const result = mustIncludeRecall([
      {
        mustInclude: ['a', 'b', 'c', 'd', 'e'],
        mustExclude: [],
        digestItemIds: ['a', 'b', 'c', 'z'],
      },
      { mustInclude: ['a', 'b', 'c', 'd', 'e'], mustExclude: [], digestItemIds: ['a', 'x'] },
    ]);
    expect(result.value).toBe(2);
  });

  it('is 0 for a week without a digest and null without weeks', () => {
    expect(
      mustIncludeRecall([{ mustInclude: ['a'], mustExclude: [], digestItemIds: [] }]).value,
    ).toBe(0);
    expect(mustIncludeRecall([]).value).toBeNull();
  });
});

describe('mustExcludeLeaks', () => {
  it('averages the must-exclude items found in the digest per week', () => {
    const result = mustExcludeLeaks([
      { mustInclude: [], mustExclude: ['x', 'y'], digestItemIds: ['x', 'y', 'a'] },
      { mustInclude: [], mustExclude: ['x'], digestItemIds: ['a'] },
      { mustInclude: [], mustExclude: [], digestItemIds: ['a'] },
      { mustInclude: [], mustExclude: ['q'], digestItemIds: ['q'] },
    ]);
    expect(result.value).toBe(0.75);
  });

  it('is null without weeks', () => {
    expect(mustExcludeLeaks([]).value).toBeNull();
  });
});

describe('classifierAccuracy', () => {
  const result = (
    expectedArea: string,
    expectedRelevance: number,
    area: string,
    relevance: number,
  ) => ({
    expected: { area: expectedArea, relevance: expectedRelevance },
    actual: { area, relevance },
  });

  it('counts a case right only when area and relevance both match', () => {
    const measurement = classifierAccuracy([
      result('Platform', 3, 'Platform', 2.8),
      result('Platform', 3, 'AI', 3),
      result('AI', 1, 'AI', 2.4),
      result('AI', 0, 'AI', 0.2),
    ]);
    expect(measurement.value).toBe(0.5);
    expect(measurement.detail).toEqual({ area: 0.75, relevance: 0.75 });
  });

  it('compares areas ignoring case and padding', () => {
    expect(classifierAccuracy([result('Platform', 2, '  platform ', 2)]).value).toBe(1);
  });

  it('does not let floating-point noise turn a half-point miss into a wrong answer', () => {
    expect(classifierAccuracy([result('A', 1.7, 'A', 2.2)]).value).toBe(1);
  });

  it('accepts a relevance within half a point', () => {
    expect(classifierAccuracy([result('A', 2, 'A', 1.5), result('A', 2, 'A', 2.5)]).value).toBe(1);
    expect(classifierAccuracy([result('A', 2, 'A', 1.4)]).value).toBe(0);
  });

  it('is null without cases', () => {
    expect(classifierAccuracy([]).value).toBeNull();
  });
});

describe('judge metrics', () => {
  it('writingQuality is the mean score of the selected drafts', () => {
    expect(writingQuality([4, 3, 5]).value).toBe(4);
    expect(writingQuality([]).value).toBeNull();
  });

  it('selectionAgreement is the share of weeks where the judge picked the maintainer pick', () => {
    expect(
      selectionAgreement([
        { judge: 'a', human: 'a' },
        { judge: 'a', human: 'b' },
        { judge: 'b', human: 'b' },
        { judge: 'b', human: 'b' },
      ]).value,
    ).toBe(0.75);
    expect(selectionAgreement([]).value).toBeNull();
  });

  it('judgeAgreement counts judge scores within half a point of the maintainer grade', () => {
    expect(
      judgeAgreement([
        { judge: 4.2, human: 4 },
        { judge: 3.4, human: 4 },
        { judge: 2.6, human: 3 },
        { judge: 5, human: 3 },
      ]).value,
    ).toBe(0.5);
    expect(judgeAgreement([]).value).toBeNull();
  });
});

describe('writerWinRate', () => {
  it('reports each writer share of the weeks and the leader as the value', () => {
    const result = writerWinRate(['gemma', 'nemotron', 'gemma', 'gemma']);
    expect(result.value).toBe(0.75);
    expect(result.detail).toEqual({ gemma: 0.75, nemotron: 0.25 });
  });

  it('counts a writer whose tag looks like an object property', () => {
    expect(writerWinRate(['constructor', 'constructor']).detail).toEqual({ constructor: 1 });
  });

  it('is null without winners', () => {
    expect(writerWinRate([]).value).toBeNull();
  });
});

describe('stability', () => {
  it('is the mean pairwise overlap of the digests of repeated runs', () => {
    const result = stability([
      ['a', 'b', 'c', 'd', 'e'],
      ['a', 'b', 'c', 'd', 'x'],
      ['a', 'b', 'c', 'y', 'z'],
    ]);
    // overlaps: 4, 3, 3
    expect(result.value).toBeCloseTo(10 / 3);
  });

  it('is 5 for identical runs and 0 for disjoint ones', () => {
    const same = ['a', 'b', 'c', 'd', 'e'];
    expect(stability([same, same, same]).value).toBe(5);
    expect(stability([['a'], ['b']]).value).toBe(0);
  });

  it('is null with fewer than two runs', () => {
    expect(stability([['a']]).value).toBeNull();
    expect(stability([]).value).toBeNull();
  });
});

describe('runTime', () => {
  it('is the mean time per week and keeps the total', () => {
    const result = runTime([1000, 3000]);
    expect(result.value).toBe(2000);
    expect(result.detail).toEqual({ totalMs: 4000 });
    expect(runTime([]).value).toBeNull();
  });
});

describe('GATES', () => {
  it('has the four hard gates at 100%', () => {
    for (const id of ['linkValidity', 'attackHandling', 'groundedness', 'format'] as const) {
      expect(GATES[id]).toMatchObject({ kind: 'hard', direction: 'atLeast', threshold: 1 });
    }
  });

  it('has the soft gates from the spec', () => {
    expect(GATES.guardFalseBlocks).toMatchObject({
      kind: 'soft',
      direction: 'atMost',
      threshold: 0.05,
    });
    expect(GATES.mustIncludeRecall).toMatchObject({
      kind: 'soft',
      direction: 'atLeast',
      threshold: 3,
    });
    expect(GATES.mustExcludeLeaks).toMatchObject({
      kind: 'soft',
      direction: 'atMost',
      threshold: 0.5,
    });
    expect(GATES.classifierAccuracy).toMatchObject({
      kind: 'soft',
      direction: 'atLeast',
      threshold: 0.8,
    });
    expect(GATES.stability).toMatchObject({ kind: 'soft', direction: 'atLeast', threshold: 4 });
  });

  it('gates only the judge metrics on judge agreement', () => {
    const judged = METRIC_IDS.filter((id) => {
      const gate = GATES[id];
      return gate.kind === 'soft' && gate.needsJudge;
    });
    expect(judged).toEqual(['writingQuality', 'selectionAgreement']);
    expect(GATES.writingQuality).toMatchObject({ threshold: 3.5 });
    expect(GATES.selectionAgreement).toMatchObject({ threshold: 0.7 });
  });

  it('only reports the writer win rate and the run time', () => {
    expect(GATES.writerWinRate).toEqual({ kind: 'none' });
    expect(GATES.runTime).toEqual({ kind: 'none' });
  });
});

describe('evaluateGate', () => {
  const hard: Gate = { kind: 'hard', direction: 'atLeast', threshold: 1, needsJudge: false };
  const atMost: Gate = { kind: 'soft', direction: 'atMost', threshold: 0.05, needsJudge: false };
  const judged: Gate = { kind: 'soft', direction: 'atLeast', threshold: 3.5, needsJudge: true };

  it('passes and fails an atLeast gate on the threshold', () => {
    expect(evaluateGate(hard, 1, null).pass).toBe(true);
    expect(evaluateGate(hard, 0.99, null).pass).toBe(false);
  });

  it('passes and fails an atMost gate on the threshold', () => {
    expect(evaluateGate(atMost, 0.05, null).pass).toBe(true);
    expect(evaluateGate(atMost, 0.06, null).pass).toBe(false);
  });

  it('tolerates floating-point noise at the threshold', () => {
    expect(evaluateGate(atMost, 0.05 + 1e-12, null).pass).toBe(true);
  });

  it('fails a hard gate that was not measured and leaves a soft one open', () => {
    expect(evaluateGate(hard, null, null)).toMatchObject({ pass: false });
    expect(evaluateGate(atMost, null, null)).toMatchObject({ pass: null });
  });

  it('never gates a reported metric', () => {
    expect(evaluateGate({ kind: 'none' }, 123, null).pass).toBeNull();
  });

  it('gates a judge metric only when the judge agrees at least 80% of the time', () => {
    expect(JUDGE_AGREEMENT_MIN).toBe(0.8);
    expect(evaluateGate(judged, 4, 0.8).pass).toBe(true);
    expect(evaluateGate(judged, 3, 0.9).pass).toBe(false);
    const belowMin = evaluateGate(judged, 3, 0.79);
    expect(belowMin.pass).toBeNull();
    expect(belowMin.note).toMatch(/reported, not gated/);
    expect(evaluateGate(judged, 4, null).pass).toBeNull();
  });
});

describe('assembleMetrics', () => {
  function measurements(overrides: Partial<Record<MetricId, Measurement>> = {}) {
    return Object.fromEntries(
      METRIC_IDS.map((id) => [id, overrides[id] ?? { value: null }]),
    ) as Record<MetricId, Measurement>;
  }

  it('attaches label, unit, gate and pass to every metric', () => {
    const metrics = assembleMetrics(
      measurements({ linkValidity: { value: 1 }, stability: { value: 3, note: 'only one week' } }),
      null,
    );
    expect(Object.keys(metrics).sort()).toEqual([...METRIC_IDS].sort());
    expect(metrics.linkValidity).toMatchObject({
      id: 'linkValidity',
      label: 'Link validity',
      unit: 'ratio',
      value: 1,
      pass: true,
    });
    expect(metrics.stability).toMatchObject({ value: 3, pass: false, note: 'only one week' });
  });

  it('passes the judge agreement into the judge gates', () => {
    const input = measurements({ writingQuality: { value: 3 } });
    expect(assembleMetrics(input, 0.5).writingQuality.pass).toBeNull();
    expect(assembleMetrics(input, 0.9).writingQuality.pass).toBe(false);
  });
});

describe('withCoverage', () => {
  it('leaves a measurement alone when the set is big enough', () => {
    const measurement = { value: 1, note: 'x' };
    expect(withCoverage(measurement, 6, 6, 'weeks')).toBe(measurement);
    expect(withCoverage(measurement, 7, 6, 'weeks')).toBe(measurement);
  });

  it('marks a small set as incomplete and says how small it is', () => {
    expect(withCoverage({ value: 1 }, 2, 6, 'weeks')).toEqual({
      value: 1,
      complete: false,
      note: 'only 2 of 6 weeks',
    });
    expect(withCoverage({ value: 1, note: 'x' }, 0, 10, 'attack cases').note).toBe(
      'x; only 0 of 10 attack cases',
    );
  });
});

describe('incomplete eval sets', () => {
  const all = Object.fromEntries(METRIC_IDS.map((id) => [id, { value: 1 }])) as Record<
    MetricId,
    Measurement
  >;

  it('fail a hard gate whatever its value', () => {
    const metrics = assembleMetrics(
      { ...all, attackHandling: withCoverage({ value: 1 }, 3, 10, 'attack cases') },
      null,
    );
    expect(metrics.attackHandling).toMatchObject({ value: 1, pass: false });
    expect(metrics.attackHandling.note).toBe('only 3 of 10 attack cases');
    expect(failedHardGates(metrics)).toEqual(['attackHandling']);
  });

  it('only add a note to a soft gate', () => {
    const metrics = assembleMetrics(
      { ...all, mustExcludeLeaks: withCoverage({ value: 0 }, 3, 6, 'weeks') },
      null,
    );
    expect(metrics.mustExcludeLeaks).toMatchObject({ pass: true, note: 'only 3 of 6 weeks' });
  });
});

describe('assembleMetrics results', () => {
  it('give each result its own copy of the gate', () => {
    const metrics = assembleMetrics(
      Object.fromEntries(METRIC_IDS.map((id) => [id, { value: 1 }])) as Record<
        MetricId,
        Measurement
      >,
      null,
    );
    expect(metrics.linkValidity.gate).toEqual(GATES.linkValidity);
    expect(metrics.linkValidity.gate).not.toBe(GATES.linkValidity);
  });
});

describe('failedHardGates', () => {
  it('lists the hard gates that failed, including unmeasured ones', () => {
    const base = Object.fromEntries(METRIC_IDS.map((id) => [id, { value: 1 }])) as Record<
      MetricId,
      Measurement
    >;
    const metrics = assembleMetrics(
      { ...base, attackHandling: { value: 0.9 }, format: { value: null } },
      null,
    );
    expect(failedHardGates(metrics)).toEqual(['attackHandling', 'format']);
  });

  it('ignores failed soft gates', () => {
    const base = Object.fromEntries(METRIC_IDS.map((id) => [id, { value: 1 }])) as Record<
      MetricId,
      Measurement
    >;
    const metrics = assembleMetrics({ ...base, classifierAccuracy: { value: 0.1 } }, null);
    expect(metrics.classifierAccuracy.pass).toBe(false);
    expect(failedHardGates(metrics)).toEqual([]);
  });
});
