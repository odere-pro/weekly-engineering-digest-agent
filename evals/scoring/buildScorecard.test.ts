import { describe, expect, it } from 'vitest';
import { PROFILES, modelsByRole } from '../../src/config/profiles';
import { renderDigest } from '../../src/render/markdown';
import { makeDigest } from '../../test/builders';
import { SECTION_METRICS } from '../checkpointSections';
import { assembleMetrics } from '../metrics';
import { METRIC_IDS, ScorecardSchema, type MetricId } from '../schema';
import { buildScorecard, withSectionOnly } from './buildScorecard';
import { measure } from './measure';
import {
  emptyCases,
  emptyRun,
  makeScoring,
  makeWeek,
  makeWeekRun,
} from './__fixtures__/scoringKit';

describe('withSectionOnly', () => {
  const metrics = assembleMetrics(measure(makeScoring()), null);

  it('is the metrics as they are on a full run', () => {
    expect(withSectionOnly(metrics, undefined)).toBe(metrics);
  });

  it('keeps the metrics of the section and marks every other one as not run', () => {
    const only = withSectionOnly(metrics, 'sources');

    const kept = new Set<MetricId>(SECTION_METRICS.sources);
    for (const id of METRIC_IDS) {
      if (kept.has(id)) expect(only[id]).toEqual(metrics[id]);
      else expect(only[id].note).toContain('not run');
    }
  });

  it('does not change the metrics it was given', () => {
    const before = JSON.stringify(metrics);

    withSectionOnly(metrics, 'guards');

    expect(JSON.stringify(metrics)).toBe(before);
  });
});

describe('buildScorecard', () => {
  const week = makeWeek();
  const markdown = renderDigest(makeDigest(week.items.slice(0, 4)), { disabledGuards: [] });
  const full = () =>
    makeScoring({
      cases: { ...emptyCases(), weeks: [week] },
      run: { ...emptyRun(), weekRuns: [makeWeekRun(week, { markdown, durationMs: 1500 })] },
    });

  it('dates the card at the start of the run and names the profile and the weeks', () => {
    const card = buildScorecard(full());

    expect(card.profile).toBe('quality');
    expect(card.date).toBe('2026-10-16T09:00:00.000Z');
    expect(card.weeks).toEqual([week.weekId]);
  });

  it('counts each kind of case', () => {
    const card = buildScorecard(full());

    expect(card.counts).toEqual({ weeks: 1, classifier: 0, attacks: 0, grounding: 0, sources: 0 });
  });

  it('records the models of the profile, and the eval judge when one scored the winners', () => {
    expect(buildScorecard(full()).models).toEqual(modelsByRole(PROFILES.quality));

    const judged = { model: 'clef:latest', scores: [4], failedWeeks: [] };
    const withJudge = makeScoring({ ...full(), run: { ...full().run, judged } });
    expect(buildScorecard(withJudge).models).toEqual({
      ...modelsByRole(PROFILES.quality),
      evalJudge: 'clef:latest',
    });
  });

  it('times the run and each week', () => {
    const card = buildScorecard(full());

    expect(card.timings).toEqual({ totalMs: 5000, byWeekMs: { [week.weekId]: 1500 } });
  });

  it('never reports a negative total when the clock went backwards', () => {
    const card = buildScorecard({ ...full(), endMs: full().startMs - 10 });

    expect(card.timings.totalMs).toBe(0);
  });

  it('has the judge agreement of the calibration, or null without one', () => {
    expect(buildScorecard(full()).judgeAgreement).toBeNull();

    const calibrated = makeScoring({
      ...full(),
      cases: {
        ...full().cases,
        calibration: { judgeAgreement: 0.9, selectionAgreement: 0.8 },
      },
    });
    expect(buildScorecard(calibrated).judgeAgreement).toBe(0.9);
  });

  it('fails the hard gates when nothing was measured', () => {
    const card = buildScorecard(makeScoring());

    expect(card.hardGatesPassed).toBe(false);
    expect(card.metrics.linkValidity).toMatchObject({ value: null, pass: false });
  });

  it('is a full card, not a partial one, without a section', () => {
    expect(buildScorecard(full())).not.toHaveProperty('partial');
  });

  it('is a partial card that names the section, with the other metrics not run', () => {
    const card = buildScorecard({ ...full(), only: 'weeks' });

    expect(card.partial).toEqual(['weeks']);
    expect(card.metrics.sourceParse.note).toContain('not run');
    expect(card.metrics.format.note ?? '').not.toContain('not run');
  });

  it('matches the scorecard schema', () => {
    const card = buildScorecard(full());

    expect(ScorecardSchema.parse(JSON.parse(JSON.stringify(card)))).toEqual(card);
  });
});
