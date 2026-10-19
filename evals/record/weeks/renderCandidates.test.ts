import { describe, expect, it } from 'vitest';
import { itemAt } from '../__fixtures__/recordKit';
import { renderCandidates } from './renderCandidates';

describe('renderCandidates', () => {
  it('lists each item as a numbered entry with id, source, title, URL and summary', () => {
    const first = itemAt('2021-01-05T10:00:00Z', {
      id: 'aaaa1111bbbb2222',
      title: 'Ollama 0.5 adds tool calling',
      url: 'https://example.com/ollama-0-5',
      summary: 'Streaming tool calls land.',
    });
    const second = itemAt('2021-01-04T09:00:00Z', {
      id: 'cccc3333dddd4444',
      sourceId: 'repo-b',
      kind: 'github',
      title: 'v1.2.0',
      url: 'https://github.com/example/repo-b/releases/tag/v1.2.0',
      summary: 'Bug fixes.',
    });

    const markdown = renderCandidates('2021-W01', [first, second]);

    expect(markdown.startsWith('# Candidates: 2021-W01\n')).toBe(true);
    expect(markdown).toContain('2 items');
    expect(markdown).toContain('1. **Ollama 0.5 adds tool calling**');
    expect(markdown).toContain('2. **v1.2.0**');
    expect(markdown).toContain('- id: `aaaa1111bbbb2222`');
    expect(markdown).toContain('- source: feed-a, published 2021-01-05');
    expect(markdown).toContain('- source: repo-b, published 2021-01-04');
    expect(markdown).toContain('- url: https://example.com/ollama-0-5');
    expect(markdown).toContain('- summary: Streaming tool calls land.');
    expect(markdown.indexOf('1. **Ollama')).toBeLessThan(markdown.indexOf('2. **v1.2.0'));
    expect(markdown.endsWith('\n')).toBe(true);
  });

  it('cuts the summary to 200 characters and keeps each entry on single lines', () => {
    const item = itemAt('2021-01-05T10:00:00Z', {
      title: 'A title\nwith a   line break',
      summary: `${'word '.repeat(100)}\nsecond line`,
    });

    const markdown = renderCandidates('2021-W01', [item]);

    const summaryLine = markdown.split('\n').find((line) => line.startsWith('   - summary: '));
    expect(summaryLine).toBeDefined();
    expect((summaryLine ?? '').slice('   - summary: '.length).length).toBeLessThanOrEqual(200);
    expect(summaryLine).toMatch(/\.\.\.$/);
    expect(markdown).toContain('1. **A title with a line break**');
  });

  it('marks items without a title or summary', () => {
    const markdown = renderCandidates('2021-W01', [
      itemAt('2021-01-05T10:00:00Z', { title: '', summary: '' }),
    ]);

    expect(markdown).toContain('1. **(untitled)**');
    expect(markdown).toContain('- summary: (none)');
  });

  it('marks a title or summary of whitespace only the same way', () => {
    const markdown = renderCandidates('2021-W01', [
      itemAt('2021-01-05T10:00:00Z', { title: ' \n ', summary: '\t' }),
    ]);

    expect(markdown).toContain('1. **(untitled)**');
    expect(markdown).toContain('- summary: (none)');
  });

  it('says so when the week has no items', () => {
    const markdown = renderCandidates('2021-W01', []);

    expect(markdown).toContain('No items were recorded for this week.');
    expect(markdown).toBe('# Candidates: 2021-W01\n\nNo items were recorded for this week.\n');
  });

  it('tells the labeler how many items there are, in the singular for one', () => {
    const one = renderCandidates('2021-W01', [itemAt('2021-01-05T10:00:00Z')]);

    expect(one).toContain(
      '1 item. Pick the 5 must-include and any must-exclude items, then copy their ids into labels.json.',
    );
  });

  it('shows the publication day in UTC', () => {
    const markdown = renderCandidates('2021-W01', [itemAt('2021-01-05T23:30:00-05:00')]);

    expect(markdown).toContain('published 2021-01-06');
  });
});
