import { describe, expect, it } from 'vitest';
import { makeRunRecord } from '../../../../test/builders';
import { scriptedPrompts } from '../../init/__fixtures__/initHarness';
import { askAgain, decideAgain } from './askAgain';

const sent = makeRunRecord({ runId: '2026-W43', status: 'sent' });
const dryRun = makeRunRecord({ runId: '2026-W43', status: 'dry-run', dryRun: true });

describe('decideAgain', () => {
  it.each([
    [{ enrich: true }, 'enrich'],
    [{ complete: true }, 'complete'],
    [{ perspective: 'security' }, 'perspective'],
    [{ addSource: ['https://a.example/feed.xml'] }, 'add-sources'],
  ] as const)('lets the flag %j win, with no terminal and no record', (options, kind) => {
    expect(decideAgain({ options, interactive: false, previous: undefined })).toBe(kind);
  });

  it('lets a flag win over --force', () => {
    const options = { enrich: true, force: true };

    expect(decideAgain({ options, interactive: true, previous: sent })).toBe('enrich');
  });

  it('refuses two flags and names them', () => {
    const options = { enrich: true, perspective: 'x' };

    expect(() => decideAgain({ options, interactive: true, previous: sent })).toThrow(
      /--enrich and --perspective/,
    );
  });

  it('ignores an empty --add-source list', () => {
    const decision = decideAgain({
      options: { addSource: [] },
      interactive: false,
      previous: sent,
    });

    expect(decision).toBeUndefined();
  });

  it.each([sent, dryRun])('asks about a $status week in a terminal', (previous) => {
    expect(decideAgain({ options: {}, interactive: true, previous })).toBe('ask');
  });

  it('does not ask under --force', () => {
    expect(decideAgain({ options: { force: true }, interactive: true, previous: sent })).toBe(
      undefined,
    );
  });

  it('does not ask without a terminal', () => {
    expect(decideAgain({ options: {}, interactive: false, previous: sent })).toBeUndefined();
  });

  it.each([undefined, makeRunRecord({ status: 'failed' }), makeRunRecord({ status: 'skipped' })])(
    'does not ask when the week has %j',
    (previous) => {
      expect(decideAgain({ options: {}, interactive: true, previous })).toBeUndefined();
    },
  );
});

describe('askAgain', () => {
  it('lists the five choices with Skip as the default', async () => {
    const { prompts, calls } = scriptedPrompts();

    const choice = await askAgain(prompts, sent);

    expect(choice).toBe('skip');
    expect(calls[0]?.message).toBe('Week 2026-W43 already has a sent digest. What now?');
    expect(calls[0]?.options.choices?.map((c) => c.name)).toEqual([
      'Rerun to enrich digest',
      'Add sources and enrich digest',
      'Generate complete digest with events',
      'Rerun with new perspective',
      'Skip',
    ]);
  });

  it('says dry-run for a dry-run week and returns the pick', async () => {
    const { prompts, calls } = scriptedPrompts([[/What now/, 'complete']]);

    expect(await askAgain(prompts, dryRun)).toBe('complete');
    expect(calls[0]?.message).toBe('Week 2026-W43 already has a dry-run digest. What now?');
  });
});
