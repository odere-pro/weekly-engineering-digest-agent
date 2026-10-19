import { describe, expect, it, vi } from 'vitest';
import type { DigestItem, Urgency } from '../../domain/schemas';
import type { ScoredItem } from '../../classify/classification';
import type { Logger } from '../../shared/telemetry';
import { SECURITY_FLOOR_ACTION, namesSecurityIssue, raiseSecurityItems } from './securityFloor';
import { makeDigestItem, makeScoredItem } from '../../../test/builders';
import { noopLogger } from '../../../test/fakes';

function spyLogger(): { logger: Logger; info: ReturnType<typeof vi.fn> } {
  const info = vi.fn();
  const logger: Logger = { ...noopLogger, info, child: () => logger };
  return { logger, info };
}

const sourceWith = (title: string, summary = 'A plain summary.'): ScoredItem =>
  makeScoredItem({ title, summary });

const itemFor = (source: ScoredItem, urgency: Urgency | undefined, action?: string): DigestItem =>
  makeDigestItem(source, {
    ...(urgency === undefined ? {} : { urgency }),
    ...(action === undefined ? {} : { action }),
  });

const indexed = (...sources: ScoredItem[]): ReadonlyMap<string, ScoredItem> =>
  new Map(sources.map((source) => [source.id, source]));

describe('namesSecurityIssue', () => {
  it.each([
    ['a CVE id', sourceWith('parser 2.1.4 fixes CVE-2026-1234')],
    ['a lowercase cve id', sourceWith('parser fixes cve-2026-1')],
    ['the word CVEs', sourceWith('Parser 2.1', 'This release patches two CVEs in the parser.')],
    ['a GitHub advisory id', sourceWith('Parser 2.1', 'Tracked as GHSA-abcd-1234-wxyz.')],
    ['a security advisory', sourceWith('Parser 2.1', 'See the security advisory for details.')],
    ['security advisories', sourceWith('Parser 2.1', 'Two security advisories were published.')],
    ['a security fix', sourceWith('Parser 2.1', 'Ships a security fix for the HTTP parser.')],
    ['security fixes', sourceWith('Parser 2.1', 'Ships security fixes.')],
    ['a security patch', sourceWith('Parser 2.1', 'This security patch is recommended.')],
    ['security patches', sourceWith('Parser 2.1', 'Includes security patches.')],
    ['a security update', sourceWith('Security updates for the runner')],
    ['a security release', sourceWith('Node.js 22.9.1 (Security Release)')],
    ['a vulnerability', sourceWith('Fix a vulnerability in the TLS stack')],
    ['vulnerabilities', sourceWith('Parser 2.1', 'Fixes several vulnerabilities.')],
    [
      'the word vulnerability in a scanner feature, which the floor deliberately counts',
      sourceWith('New vulnerability scanner UI'),
    ],
  ])('is true when the source names %s', (_name, source) => {
    expect(namesSecurityIssue(source)).toBe(true);
  });

  it.each([
    [
      'a secure-by-default setting',
      sourceWith('A secure-by-default setting', 'Safe defaults, no advisories.'),
    ],
    ['the word security alone', sourceWith('Security team joins the project')],
    [
      'a security word that is not a release word',
      sourceWith('Parser 2.1', 'Better security posture overall.'),
    ],
    [
      'vulnerable, which is not vulnerability',
      sourceWith('Parser 2.1', 'Do not run a vulnerable build.'),
    ],
    ['a word that only contains cve', sourceWith('Parser 2.1', 'The cvexyz option is new.')],
    ['GHSA without a dash', sourceWith('Parser 2.1', 'GHSA is a database.')],
    ['nothing about security', sourceWith('Runner 2.4 adds GPU runners')],
  ])('is false when the source has %s', (_name, source) => {
    expect(namesSecurityIssue(source)).toBe(false);
  });

  it('reads the title and the summary, and nothing else', () => {
    const source = {
      ...sourceWith('Parser 2.1'),
      url: 'https://example.com/cve-2026-1/vulnerability',
    };

    expect(namesSecurityIssue(source)).toBe(false);
  });
});

describe('raiseSecurityItems', () => {
  const secure = sourceWith('Fix CVE-2026-1234 in the parser');
  const plain = sourceWith('Runner 2.4 adds GPU runners');

  it('raises a good-to-know item whose source names a security issue, and logs it', () => {
    const { logger, info } = spyLogger();
    const item = itemFor(secure, 'good-to-know', 'Check your images');

    const [raised] = raiseSecurityItems([item], indexed(secure), logger);

    expect(raised).toMatchObject({ urgency: 'worth-a-look', action: 'Check your images' });
    expect(info).toHaveBeenCalledWith('Raised urgency: the source names a security issue', {
      itemId: secure.id,
      from: 'good-to-know',
      to: 'worth-a-look',
    });
  });

  it('gives the raised item the fixed action when the writer gave it none', () => {
    const [raised] = raiseSecurityItems(
      [itemFor(secure, 'good-to-know')],
      indexed(secure),
      noopLogger,
    );

    expect(raised?.action).toBe(SECURITY_FLOOR_ACTION);
  });

  it.each(['act-now', 'worth-a-look'] as const)(
    'never demotes or rewrites a %s item, and logs nothing',
    (urgency) => {
      const { logger, info } = spyLogger();
      const item = itemFor(secure, urgency, 'Upgrade the parser now');

      const [result] = raiseSecurityItems([item], indexed(secure), logger);

      expect(result).toBe(item);
      expect(info).not.toHaveBeenCalled();
    },
  );

  it('never lowers an item: every urgency ends at worth-a-look or above', () => {
    const rank: Record<string, number> = { 'good-to-know': 0, 'worth-a-look': 1, 'act-now': 2 };
    const urgencies = ['good-to-know', 'worth-a-look', 'act-now'] as const;
    const items = urgencies.map((urgency) => itemFor(secure, urgency, 'x'));

    const result = raiseSecurityItems(items, indexed(secure), noopLogger);

    result.forEach((item, index) => {
      expect(rank[item.urgency ?? 'good-to-know']).toBeGreaterThanOrEqual(rank[urgencies[index]!]!);
      expect(rank[item.urgency ?? 'good-to-know']).toBeGreaterThanOrEqual(1);
    });
  });

  it('leaves an item with no urgency alone', () => {
    const item = itemFor(secure, undefined);

    expect(raiseSecurityItems([item], indexed(secure), noopLogger)[0]).toBe(item);
  });

  it('leaves a good-to-know item alone when its source says nothing about security', () => {
    const { logger, info } = spyLogger();
    const item = itemFor(plain, 'good-to-know', '');

    const [result] = raiseSecurityItems([item], indexed(plain), logger);

    expect(result).toBe(item);
    expect(info).not.toHaveBeenCalled();
  });

  it('reads the source, not the writer: a CVE only in the written text raises nothing', () => {
    const item = { ...itemFor(plain, 'good-to-know'), summary: 'Mentions CVE-2026-1.' };

    expect(raiseSecurityItems([item], indexed(plain), noopLogger)[0]?.urgency).toBe('good-to-know');
  });

  it('leaves an item whose source is not known alone', () => {
    const item = itemFor(secure, 'good-to-know');

    expect(raiseSecurityItems([item], new Map(), noopLogger)[0]).toBe(item);
  });

  it('keeps the order, raises only the items that need it, and returns new items', () => {
    const items = [itemFor(plain, 'good-to-know'), itemFor(secure, 'good-to-know', 'Check')];
    const snapshot = structuredClone(items);

    const result = raiseSecurityItems(items, indexed(plain, secure), noopLogger);

    expect(result.map((item) => item.urgency)).toEqual(['good-to-know', 'worth-a-look']);
    expect(items).toEqual(snapshot);
  });

  it('cuts a long itemId in the log line', () => {
    const { logger, info } = spyLogger();
    const source = { ...secure, id: 'y'.repeat(5_000) };

    raiseSecurityItems([itemFor(source, 'good-to-know')], indexed(source), logger);

    const fields = info.mock.calls[0]?.[1] as { itemId: string };
    expect(fields.itemId.startsWith('yyyy')).toBe(true);
    expect(fields.itemId.length).toBeLessThanOrEqual(80);
  });
});
