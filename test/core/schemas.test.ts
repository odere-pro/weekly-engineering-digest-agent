import { describe, expect, it } from 'vitest';
import {
  DigestSchema,
  ExitCode,
  ItemSchema,
  RunRecordSchema,
  exitCodeFor,
} from '../../src/core/schemas.js';
import { makeDigest, makeItem, makeRunRecord } from '../builders.js';

describe('schemas', () => {
  it('maps run status to the spec exit codes', () => {
    expect(exitCodeFor('sent')).toBe(ExitCode.Sent);
    expect(exitCodeFor('dry-run')).toBe(0);
    expect(exitCodeFor('skipped')).toBe(0);
    expect(exitCodeFor('failed')).toBe(1);
    expect(exitCodeFor('blocked')).toBe(2);
    expect(exitCodeFor('quiet')).toBe(3);
  });

  it('builders produce valid objects', () => {
    const item = makeItem();
    expect(ItemSchema.parse(item)).toEqual(item);
    expect(DigestSchema.parse(makeDigest([item])).items).toHaveLength(1);
    expect(RunRecordSchema.parse(makeRunRecord()).runId).toBe('2026-W42');
  });

  describe('RunRecord sampling', () => {
    const sampling = { seed: 42, temperatureByRole: { write: 0.7, classify: 0 } };

    it('accepts an old record without sampling', () => {
      expect(RunRecordSchema.parse(makeRunRecord()).sampling).toBeUndefined();
    });

    it('keeps the seed and the temperature per role', () => {
      expect(RunRecordSchema.parse({ ...makeRunRecord(), sampling }).sampling).toEqual(sampling);
    });

    it('rejects a negative or fractional seed', () => {
      for (const seed of [-1, 1.5])
        expect(
          RunRecordSchema.safeParse({ ...makeRunRecord(), sampling: { ...sampling, seed } })
            .success,
        ).toBe(false);
    });
  });

  describe('RunRecord counts.afterProcess', () => {
    const counts = makeRunRecord().counts;
    const withCounts = (extra: Record<string, unknown>) =>
      RunRecordSchema.safeParse({ ...makeRunRecord(), counts: { ...counts, ...extra } });

    it('accepts an old record without the count', () => {
      expect('afterProcess' in counts).toBe(false);
      expect(RunRecordSchema.safeParse(makeRunRecord()).success).toBe(true);
    });

    it('keeps the count when present', () => {
      const parsed = withCounts({ afterProcess: 40 });
      expect(parsed.success && parsed.data.counts.afterProcess).toBe(40);
    });

    it('rejects a negative or fractional count', () => {
      expect(withCounts({ afterProcess: -1 }).success).toBe(false);
      expect(withCounts({ afterProcess: 1.5 }).success).toBe(false);
    });
  });

  it('rejects a bad week id', () => {
    expect(DigestSchema.safeParse(makeDigest([makeItem()], { weekId: '2026-43' })).success).toBe(
      false,
    );
  });
});
