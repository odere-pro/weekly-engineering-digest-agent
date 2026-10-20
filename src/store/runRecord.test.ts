import { describe, expect, it } from 'vitest';
import { makeRunRecord } from '../../test/builders';
import { RunRecordSchema } from './runRecord';

describe('RunRecordSchema', () => {
  it('parses what the builder makes', () => {
    expect(RunRecordSchema.parse(makeRunRecord()).runId).toBe('2026-W42');
  });

  describe('fallback', () => {
    it('accepts an old record without the flag and keeps it when present', () => {
      expect(RunRecordSchema.parse(makeRunRecord())).not.toHaveProperty('fallback');
      expect(RunRecordSchema.parse({ ...makeRunRecord(), fallback: true }).fallback).toBe(true);
      expect(RunRecordSchema.safeParse({ ...makeRunRecord(), fallback: 'yes' }).success).toBe(
        false,
      );
    });
  });

  describe('sampling', () => {
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

  describe('counts.afterProcess', () => {
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
});

describe('variant', () => {
  it('accepts an old record without it', () => {
    expect(RunRecordSchema.parse(makeRunRecord()).variant).toBeUndefined();
  });

  it('keeps the kind, topic and added sources', () => {
    const variant = { kind: 'perspective', topic: 'security', addedSources: ['a'] } as const;
    expect(RunRecordSchema.parse({ ...makeRunRecord(), variant }).variant).toEqual(variant);
  });

  it('rejects an unknown kind and a topic over 200 characters', () => {
    const bad = (variant: unknown) =>
      RunRecordSchema.safeParse({ ...makeRunRecord(), variant }).success;
    expect(bad({ kind: 'redo' })).toBe(false);
    expect(bad({ kind: 'perspective', topic: 'x'.repeat(201) })).toBe(false);
  });
});
