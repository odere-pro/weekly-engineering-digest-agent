import { describe, expect, it } from 'vitest';
import { DraftsFileSchema, ItemsFileSchema, ScoresFileSchema, toJson } from './runFiles';
import { makeClassification, makeDraft, makeItem } from '../../../../test/builders';

describe('toJson', () => {
  it('writes pretty JSON with a trailing newline', () => {
    expect(toJson({ a: [1, 2] })).toBe('{\n  "a": [\n    1,\n    2\n  ]\n}\n');
  });

  it('writes an empty list on one line', () => {
    expect(toJson([])).toBe('[]\n');
  });
});

describe('the run file schemas', () => {
  const item = makeItem();

  it('read back what the run wrote', () => {
    expect(ItemsFileSchema.parse(JSON.parse(toJson([item])))).toEqual([item]);
    const scores = [makeClassification(item.id)];
    expect(ScoresFileSchema.parse(JSON.parse(toJson(scores)))).toEqual(scores);
  });

  it('keep only the drafts of drafts.json, whatever else the file holds', () => {
    const draft = makeDraft([item], 'writer-a');
    const file = { drafts: [draft], failures: [{ writer: 'w', error: 'x' }], rejections: [] };

    expect(DraftsFileSchema.parse(JSON.parse(toJson(file)))).toEqual({ drafts: [draft] });
  });

  it('refuse a file that is not what the run wrote', () => {
    expect(() => ItemsFileSchema.parse({ not: 'a list' })).toThrow();
    expect(() => DraftsFileSchema.parse({ drafts: [{ writer: 'w' }] })).toThrow();
  });
});
