import { describe, expect, it } from 'vitest';
import { buildRecord } from './buildRecord';
import { RunRecordSchema } from '../../store/runRecord';
import { contextFor, stateOf } from '../__fixtures__/stageKit';
import type { RunVariant } from '../variant';

describe('buildRecord with a variant', () => {
  const build = (variant?: RunVariant) =>
    buildRecord(contextFor({ variant }).ctx, { state: stateOf() }, 'dry-run', new Date());

  it('copies the kind, topic and added sources and never the kept URLs', () => {
    const record = build({
      kind: 'add-sources',
      topic: 'security',
      addedSources: ['s1'],
      keepUrls: ['https://example.com/a'],
    });

    expect(record.variant).toEqual({
      kind: 'add-sources',
      topic: 'security',
      addedSources: ['s1'],
    });
    expect(JSON.stringify(record)).not.toContain('example.com/a');
    expect(RunRecordSchema.parse(record)).toEqual(record);
  });

  it('cuts a long topic to the schema limit', () => {
    const record = build({ kind: 'perspective', topic: 'x'.repeat(500) });

    expect(record.variant?.topic).toHaveLength(200);
    expect(RunRecordSchema.safeParse(record).success).toBe(true);
  });

  it('leaves the field out without a variant', () => {
    expect(build()).not.toHaveProperty('variant');
  });
});
