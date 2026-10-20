import { describe, expect, it } from 'vitest';
import { markVariantSent } from './markSent';
import { DigestError } from '../../shared/errors';
import { fixedClock } from '../../../test/fakes';
import { NOW, WEEK } from '../__fixtures__/stageKit';
import { record, setupEnding } from './__fixtures__/endingKit';

const UA = 'https://example.com/a';
const UB = 'https://example.com/b';
const variant = { kind: 'perspective', topic: 'security', keepUrls: [UA] } as const;

function setup(stored?: ReturnType<typeof record>) {
  const h = setupEnding();
  if (stored) h.store.records.set(WEEK, stored);
  const deps = { store: h.store, clock: fixedClock(NOW) };
  return { h, deps };
}

describe('markVariantSent', () => {
  it('turns a dry-run week into a sent one with the channels and URLs of the variant', async () => {
    const { h, deps } = setup(record({ status: 'dry-run', dryRun: true, sentUrls: [] }));

    const saved = await markVariantSent(deps, WEEK, ['markdown'], [UA], variant);

    expect(saved).toMatchObject({
      status: 'sent',
      dryRun: false,
      deliveredTo: ['markdown'],
      sentUrls: [UA],
      finishedAt: new Date(NOW).toISOString(),
      variant: { kind: 'perspective', topic: 'security' },
    });
    expect(h.store.records.get(WEEK)).toEqual(saved);
  });

  it('adds to a sent week: channels and URLs are unions, never the kept URLs', async () => {
    const { deps } = setup(record({ status: 'sent', deliveredTo: ['email'], sentUrls: [UA] }));

    const saved = await markVariantSent(deps, WEEK, ['markdown', 'email'], [UA, UB], {
      kind: 'add-sources',
      addedSources: ['s1'],
    });

    expect(saved.status).toBe('sent');
    expect(saved.deliveredTo).toEqual(['email', 'markdown']);
    expect(saved.sentUrls).toEqual([UA, UB]);
    expect(saved.variant).toEqual({ kind: 'add-sources', addedSources: ['s1'] });
  });

  it.each([['failed' as const], ['quiet' as const], ['blocked' as const]])(
    'throws for a %s week',
    async (status) => {
      const { deps } = setup(record({ status }));
      await expect(markVariantSent(deps, WEEK, [], [], variant)).rejects.toBeInstanceOf(
        DigestError,
      );
    },
  );

  it('throws for a week with no record', async () => {
    const { deps } = setup();
    await expect(markVariantSent(deps, WEEK, [], [], variant)).rejects.toThrow(/2026-W42/);
  });
});
