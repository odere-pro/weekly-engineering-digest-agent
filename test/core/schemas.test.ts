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

  it('rejects a bad week id', () => {
    expect(DigestSchema.safeParse(makeDigest([makeItem()], { weekId: '2026-43' })).success).toBe(
      false,
    );
  });
});
