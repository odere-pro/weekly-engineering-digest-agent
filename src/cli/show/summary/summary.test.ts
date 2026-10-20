import { describe, expect, it } from 'vitest';
import { summary } from './summary';
import type { RunRecord } from '../../../store/runRecord';
import { makeRunRecord } from '../../../../test/builders';

const full = makeRunRecord({
  runId: '2026-W42',
  status: 'sent',
  profile: 'quality',
  startedAt: '2026-10-12T05:45:00Z',
  finishedAt: '2026-10-12T05:52:12Z',
  timings: [
    { step: 'collect', ms: 1500 },
    { step: 'write', ms: 90_000 },
  ],
  counts: { collected: 30, afterGuardInput: 28, classified: 28, selected: 5, digestItems: 4 },
  winner: 'writer-a',
  deliveredTo: ['markdown', 'email'],
  disabledGuards: ['graniteRisk'],
  drafts: [
    { writer: 'writer-a', passed: true, rejectedBy: [] },
    { writer: 'writer-b', passed: false, rejectedBy: ['linkCheck', 'formatCheck'] },
    { writer: 'writer-c', passed: false, rejectedBy: [] },
  ],
  failedSources: [{ sourceId: 'feed-x', error: 'HTTP 500' }],
});

describe('summary', () => {
  it('prints a line for the status, profile, start, counts, winner, delivery, guards and timings', () => {
    expect(summary(full)).toBe(
      [
        'Week 2026-W42: sent',
        'Profile:    quality',
        'Started:    2026-10-12T05:45:00Z (7m 12s)',
        'Items:      30 collected, 28 after guards, 28 classified, 5 selected, 4 in the digest',
        'Winner:     writer-a',
        'Delivered:  markdown, email',
        'Guards off: graniteRisk',
        'Timings:    collect 1.5s, write 1m 30s',
        'Rejected:   writer-b by linkCheck, formatCheck',
        'Rejected:   writer-c by -',
        'Source failed: feed-x: HTTP 500',
        '',
      ].join('\n'),
    );
  });

  it('names the rule guard, and what the model guards checked, for a run that guarded candidates', () => {
    const record = makeRunRecord({
      counts: {
        collected: 147,
        afterGuardInput: 147,
        classified: 147,
        afterProcess: 58,
        selected: 5,
        guardedCandidates: 5,
        digestItems: 5,
      },
    });

    expect(summary(record).split('\n')).toContain(
      'Items:      147 collected, 147 after the rule guard, 147 classified, 5 selected ' +
        '(model guards checked 5), 5 in the digest',
    );
  });

  it('marks a dry run', () => {
    expect(summary(makeRunRecord({ dryRun: true })).split('\n')[0]).toBe(
      'Week 2026-W42: sent (dry run)',
    );
  });

  it('says none for what a run never had, and a dash for no timings', () => {
    const lines = summary(makeRunRecord({ winner: null, status: 'quiet' })).split('\n');
    expect(lines).toContain('Winner:     none');
    expect(lines).toContain('Delivered:  none');
    expect(lines).toContain('Guards off: none');
    expect(lines).toContain('Timings:    -');
  });

  it('prints the error of a failed run, with its step when it has one', () => {
    const withStep = summary(
      makeRunRecord({ status: 'failed', error: { message: 'Every writer failed', step: 'write' } }),
    );
    expect(withStep).toContain('Error:      Every writer failed (step write)\n');
    const withoutStep = summary(makeRunRecord({ status: 'failed', error: { message: 'boom' } }));
    expect(withoutStep).toContain('Error:      boom\n');
    expect(withoutStep).not.toContain('(step');
  });

  it('puts the error last and cuts a long source error', () => {
    const text = summary(
      makeRunRecord({
        failedSources: [{ sourceId: 'feed-x', error: 'e'.repeat(500) }],
        error: { message: 'boom' },
      }),
    );
    const lines = text.trimEnd().split('\n');
    expect(lines.at(-1)).toBe('Error:      boom');
    const failed = lines.find((line) => line.startsWith('Source failed:')) ?? '';
    expect(failed).toBe(`Source failed: feed-x: ${'e'.repeat(197)}...`);
  });

  describe('variant line', () => {
    const variantLine = (variant: RunRecord['variant']): string | undefined =>
      summary(makeRunRecord({ variant }))
        .split('\n')
        .find((l) => l.startsWith('Variant:'));

    it('prints no line for an old record', () => {
      expect(summary(makeRunRecord())).not.toContain('Variant:');
    });

    it.each([
      [{ kind: 'enrich' as const }, 'Variant:    enriched'],
      [{ kind: 'complete' as const }, 'Variant:    complete'],
      [{ kind: 'perspective' as const, topic: 'security' }, 'Variant:    perspective: security'],
      [{ kind: 'perspective' as const }, 'Variant:    perspective'],
      [{ kind: 'add-sources' as const }, 'Variant:    enriched'],
      [
        { kind: 'add-sources' as const, addedSources: ['a', 'b'] },
        'Variant:    enriched (added: a, b)',
      ],
    ])('prints %j as %s', (variant, line) => {
      expect(variantLine(variant)).toBe(line);
    });
  });
});
