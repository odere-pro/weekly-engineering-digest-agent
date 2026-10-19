import { readFileSync, writeFileSync } from 'node:fs';
import { expect } from 'vitest';
import type { DigestView, DigestViewGroup, DigestViewItem } from '../../../Delivery';

// The view, builders and hostile strings the email tests share. The golden files sit beside it.
const FIXTURES = new URL('./', import.meta.url);

export function fixture(name: string): string {
  return readFileSync(new URL(name, FIXTURES), 'utf8');
}

/** Compares with a golden file; UPDATE_GOLDEN=1 rewrites it so a layout change is one command. */
export function expectGolden(actual: string, name: string): void {
  if (process.env['UPDATE_GOLDEN'] === '1') writeFileSync(new URL(name, FIXTURES), actual);
  expect(actual).toBe(fixture(name));
}

export const fullView = JSON.parse(fixture('full.view.json')) as DigestView;

export function item(overrides: Partial<DigestViewItem> = {}): DigestViewItem {
  return {
    title: 'Release',
    url: 'https://example.com/release',
    whatChanged: 'Something changed.',
    ...overrides,
  };
}

export function group(
  urgency: DigestViewGroup['urgency'],
  items: DigestViewItem[],
  label = 'Label',
): DigestViewGroup {
  return { urgency, label, items };
}

export function viewOf(groups: DigestViewGroup[], overrides: Partial<DigestView> = {}): DigestView {
  return {
    weekId: '2026-W42',
    title: 'Week 2026-W42: 1 release, nothing needs action',
    headline: 'A quiet week.',
    groups,
    ...overrides,
  };
}

/** URLs that must never become a link or a printed URL line. */
export const NOT_HTTP_URLS = [
  'javascript:alert(1)',
  'JaVaScRiPt:alert(1)',
  ' javascript:alert(1)',
  'java\tscript:alert(1)',
  '\u0001javascript:alert(1)',
  'data:text/html;base64,PHNjcmlwdD4=',
  'vbscript:msgbox(1)',
  'ftp://example.com/file',
  '/releases',
  '//example.com/releases',
  'https://',
  'https:foo',
  'https:/foo',
  'http:example.com',
  'https://example.com/a b',
  'https://example.com/\n',
  'https://exa​mple.com/',
  'https://example.com/‮abc',
  'https://github.com@evil.test/x',
  'https://user:pw@example.com/',
  '',
];

export const HOSTILE = `<script>alert("x")</script> & 'q' "d"`;
export const HOSTILE_ESCAPED =
  '&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt; &amp; &#39;q&#39; &quot;d&quot;';
