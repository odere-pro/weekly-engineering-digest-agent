import { describe, expect, it } from 'vitest';
import { makeDraft, makeItem } from '../../../test/builders';
import { FakeInputGuard, FakeOutputGuard } from '../../../test/fakes';
import { AREAS } from '../__fixtures__/records';
import { captureDeps, evalSet, scriptedModel } from '../__fixtures__/captureKit';
import { captureRaw, type CaptureDeps } from './captureRaw';
import type { EvalSet } from './subjects';

describe('captureRaw', () => {
  it('stores what the classifier said about every case and every week item', async () => {
    const set = evalSet();
    const raw = await captureRaw(set, captureDeps(scriptedModel()));
    expect(raw.classifier).toHaveLength(2);
    expect(raw.classifier[1]).toEqual({
      itemId: set.classifier.cases[1]!.item.id,
      expected: { area: AREAS[1], relevance: 1 },
      result: { relevance: 2, area: AREAS[1], areaConfidence: 0.7, hype: 0.2, minorRelease: 0.9 },
    });
    expect(raw.weekItems.map((w) => w.label)).toEqual(['mustInclude', 'mustExclude', null]);
  });

  it('stores clefPolicy P(yes) and the granite verdict for every clean item and attack', async () => {
    const raw = await captureRaw(evalSet(), captureDeps(scriptedModel()));
    expect(raw.inputGuards.map((g) => [g.kind, g.from])).toEqual([
      ['clean', '2026-W40'],
      ['clean', '2026-W40'],
      ['clean', '2026-W40'],
      ['attack', 'attack-01'],
    ]);
    expect(raw.inputGuards[3]).toMatchObject({
      clefPolicy: { probability: 0.95 },
      graniteRisk: { flagged: true, reason: 'granite4.1-guardian flagged jailbreak' },
    });
    expect(raw.inputGuards[0]).toMatchObject({
      clefPolicy: { probability: 0.05 },
      graniteRisk: { flagged: false },
    });
  });

  it('checks each grounding draft and its clean control with clefRubric', async () => {
    const raw = await captureRaw(evalSet(), captureDeps(scriptedModel()));
    expect(raw.outputGuards).toEqual([
      { caseId: 'grounding-01', draft: 'planted', clefRubric: { probability: 0.05 } },
      { caseId: 'grounding-01', draft: 'control', clefRubric: { probability: 0.05 } },
    ]);
  });

  it('calls one model at a time: every decision call before the first granite call', async () => {
    const scripted = scriptedModel();
    await captureRaw(evalSet(), captureDeps(scripted));
    const firstGranite = scripted.calls.indexOf('guardRisk');
    expect(firstGranite).toBeGreaterThan(0);
    expect(scripted.calls.slice(firstGranite).every((role) => role === 'guardRisk')).toBe(true);
  });

  it('runs the phases in a fixed order: classifier, week items, clefPolicy, clefRubric, granite', async () => {
    const progress: string[] = [];
    await captureRaw(evalSet(), captureDeps(scriptedModel(), progress));
    const phases = [
      'classifier cases:',
      'week items:',
      'clefPolicy:',
      'clefRubric:',
      'graniteRisk:',
    ];
    const at = phases.map((phase) => progress.findIndex((line) => line.startsWith(phase)));
    expect(at.every((index) => index >= 0)).toBe(true);
    expect(at).toEqual([...at].sort((a, b) => a - b));
  });

  it('records a failed call with its message and goes on with the next subject', async () => {
    const progress: string[] = [];
    const raw = await captureRaw(evalSet(), captureDeps(scriptedModel('patch'), progress));
    const patchCase = raw.classifier[1]!;
    expect(patchCase.result).toEqual({ error: 'model timed out' });
    expect(raw.classifier[0]!.result).not.toHaveProperty('error');
    expect(raw.inputGuards[1]!.clefPolicy).toEqual({ error: 'model timed out' });
    expect(
      progress.some((line) => line.includes('failed') && line.includes('model timed out')),
    ).toBe(true);
  });

  it('logs progress and the time each phase took', async () => {
    const progress: string[] = [];
    const raw = await captureRaw(evalSet(), captureDeps(scriptedModel(), progress));
    expect(progress).toContain('classifier cases: 2/2');
    expect(Object.keys(raw.timingsMs)).toEqual([
      'classifier',
      'weekItems',
      'clefPolicy',
      'clefRubric',
      'graniteRisk',
    ]);
  });
});

describe('captureRaw with guards that give no probability', () => {
  it('records an error for a decision guard verdict without a probability', async () => {
    const scripted = scriptedModel();
    const deps: CaptureDeps = {
      ...captureDeps(scripted),
      clefPolicy: new FakeInputGuard('clefPolicy'),
      clefRubric: new FakeOutputGuard('clefRubric'),
    };
    const raw = await captureRaw(evalSet(), deps);
    expect(raw.inputGuards[0]?.clefPolicy).toEqual({
      error: expect.stringContaining('clefPolicy gave no probability') as string,
    });
    expect(raw.outputGuards[0]?.clefRubric).toEqual({
      error: expect.stringContaining('clefRubric gave no probability') as string,
    });
  });

  it('checks a one-item grounding draft without a control', async () => {
    const source = makeItem();
    const set: EvalSet = {
      ...evalSet(),
      grounding: [
        { id: 'g1', draft: makeDraft([source]), sources: [source], plantedItemId: source.id },
      ],
    };
    const raw = await captureRaw(set, captureDeps(scriptedModel()));
    expect(raw.outputGuards.map((g) => g.draft)).toEqual(['planted']);
  });
});

describe('captureRaw safeguards', () => {
  it('refuses labels the maintainer has not reviewed', async () => {
    const set = evalSet();
    const unreviewed = { ...set, classifier: { ...set.classifier, reviewed: false } };
    await expect(captureRaw(unreviewed, captureDeps(scriptedModel()))).rejects.toThrow(
      'not reviewed',
    );
  });

  it('records a call that threw without a message as an unknown error', async () => {
    const deps: CaptureDeps = {
      ...captureDeps(scriptedModel()),
      graniteRisk: { id: 'graniteRisk', checkItem: () => Promise.reject(new Error('')) },
    };
    const raw = await captureRaw(evalSet(), deps);
    expect(raw.inputGuards[0]?.graniteRisk).toEqual({ error: 'unknown error' });
  });

  it('never stores a negative duration when the clock steps back', async () => {
    let now = Date.parse('2026-10-17T10:00:00Z');
    const clock = { now: () => new Date((now -= 1000)) };
    const raw = await captureRaw(evalSet(), { ...captureDeps(scriptedModel()), clock });
    expect(Object.values(raw.timingsMs).every((ms) => ms === 0)).toBe(true);
  });
});
