import { describe, expect, it } from 'vitest';
import { harness, sentResult, text } from '../__fixtures__/runHarness';
import { keptNote, LABEL_WIDTH, printSummary, statusNote, type Reporter } from './summary';

describe('statusNote', () => {
  it.each([
    ['dry-run', 'Dry run: nothing was sent.'],
    ['skipped', 'This week already has a sent digest. Use --force to run it again.'],
    ['sent', undefined],
  ] as const)('maps %s', (status, note) => {
    expect(statusNote(status)).toBe(note);
  });
});

describe('keptNote', () => {
  it('says the run folder is unchanged', () => {
    expect(keptNote('Held')).toBe("Held. The week's run folder is unchanged.");
  });
});

describe('printSummary', () => {
  it('pads labels to LABEL_WIDTH and lists local files', () => {
    const h = harness();
    const out: string[] = [];
    const report: Reporter = { out: (t) => out.push(t), err: () => undefined };

    printSummary(report, h.loaded, sentResult(), { markdown: '/d/w.md', html: '/d/w.html' });

    expect(LABEL_WIDTH).toBe(8);
    expect(text(out)).toContain('Week      2026-W43\n');
    expect(text(out)).toContain('Markdown  /d/w.md\n');
    expect(text(out)).toContain('HTML      /d/w.html\n');
  });

  it('adds a Variant line and drops the dry-run note for a variant', () => {
    const h = harness();
    const out: string[] = [];
    const report: Reporter = { out: (t) => out.push(t), err: () => undefined };
    const result = sentResult({ status: 'dry-run' });

    printSummary(report, h.loaded, result, undefined, { kind: 'perspective', topic: 'security' });

    expect(text(out)).toContain('Variant   perspective: security\n');
    expect(text(out)).not.toContain('Dry run: nothing was sent.');
  });
});
