import { describe, expect, it } from 'vitest';
import { normalizeText } from './normalizeText';

describe('normalizeText', () => {
  it.each([
    ['lowercases', 'Kubernetes 1.34 Is OUT', 'kubernetes 1 34 is out'],
    ['collapses runs of spaces and punctuation', '  hello,   world!! ', 'hello world'],
    ['folds full-width letters (NFKC)', 'Ｋｕｂｅ １', 'kube 1'],
    ['keeps non-ASCII letters apart', 'Größe', 'größe'],
    ['keeps + and #', 'C++ and C#', 'c++ and c#'],
    ['turns hyphens into spaces', 'claude-code', 'claude code'],
    ['returns an empty string for punctuation only', ' --- !! ', ''],
    ['returns an empty string for an empty string', '', ''],
  ])('%s', (_name, text, expected) => {
    expect(normalizeText(text)).toBe(expected);
  });
});
