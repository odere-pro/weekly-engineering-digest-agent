import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { parseFile } from './parseFile';
import { ShowError } from './showError';

const NumbersSchema = z.array(z.number());

describe('parseFile', () => {
  it('returns the parsed value when the text is JSON of the expected shape', () => {
    expect(parseFile('scores.json', '[1, 2, 3]', NumbersSchema)).toEqual([1, 2, 3]);
  });

  it('names the file and the parse error when the text is not JSON', () => {
    expect(() => parseFile('items.json', '{nope', NumbersSchema)).toThrow(ShowError);
    expect(() => parseFile('items.json', '{nope', NumbersSchema)).toThrow(
      /^items\.json is not valid JSON: /,
    );
  });

  it('names the file when the JSON does not match the schema', () => {
    expect(() => parseFile('drafts.json', '["a"]', NumbersSchema)).toThrow(ShowError);
    expect(() => parseFile('drafts.json', '["a"]', NumbersSchema)).toThrow(
      'drafts.json does not have the expected shape',
    );
  });

  it('does not put the file content in a shape error', () => {
    const attempt = (): unknown =>
      parseFile('scores.json', '["hunter2-secret-token"]', NumbersSchema);
    expect(attempt).toThrow(/^scores\.json does not have the expected shape$/);
  });
});
