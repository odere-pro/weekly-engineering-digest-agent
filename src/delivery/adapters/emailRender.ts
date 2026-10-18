import type { DigestView, DigestViewGroup, DigestViewItem } from '../Delivery';

type Urgency = DigestViewGroup['urgency'];

interface Column {
  header: string;
  /** Width in percent. */
  width: number;
}

interface UrgencyLayout {
  emoji: string;
  /** Release and What changed. */
  columns: readonly Column[];
  /** The third column; good-to-know has none. */
  action?: Column;
}

const ACT_NOW_ACTION: Column = { header: 'What to do', width: 30 };
const WORTH_A_LOOK_ACTION: Column = { header: 'Relevant if you', width: 30 };

const LAYOUT: Readonly<Record<Urgency, UrgencyLayout>> = {
  'act-now': {
    emoji: '🔴',
    columns: [
      { header: 'Release', width: 28 },
      { header: 'What changed', width: 42 },
    ],
    action: ACT_NOW_ACTION,
  },
  'worth-a-look': {
    emoji: '🟡',
    columns: [
      { header: 'Release', width: 28 },
      { header: 'What changed', width: 42 },
    ],
    action: WORTH_A_LOOK_ACTION,
  },
  'good-to-know': {
    emoji: '⚪',
    columns: [
      { header: 'Release', width: 35 },
      { header: 'What changed', width: 65 },
    ],
  },
};

const NO_ACTION = '—';
const UNTITLED = '(untitled)';

// Whitespace, control characters and bidirectional overrides, so a model string stays on one
// line and cannot reorder the text around it. Other format characters (ZWJ emoji) stay.
const BLANK_RUN = /[\s\p{Cc}‪-‮⁦-⁩]+/gu;
const HAS_UNSAFE_CHAR = /[\s\p{Cc}\p{Cf}]/u;
const HTTP_SCHEME = /^https?:\/\//i;

/** One line: line breaks, tabs, control and bidi characters become single spaces. */
function oneLine(text: string): string {
  return text.replaceAll(BLANK_RUN, ' ').trim();
}

/** A release title on one line, or a placeholder when nothing is left of it. */
function titleOf(item: DigestViewItem): string {
  return oneLine(item.title) || UNTITLED;
}

/**
 * The URL in its normalised form when it is an absolute http(s) URL, otherwise undefined.
 * Whitespace, control and format characters, a scheme without `//` and credentials in the URL
 * (`https://github.com@evil.test/`) are all refused, so what is linked is what a reader sees.
 */
function httpUrl(raw: string): string | undefined {
  if (HAS_UNSAFE_CHAR.test(raw) || !HTTP_SCHEME.test(raw)) return undefined;
  try {
    const url = new URL(raw);
    const hasCredentials = url.username !== '' || url.password !== '';
    return hasCredentials ? undefined : url.href;
  } catch {
    return undefined;
  }
}

/** The columns of a group's table, in order. */
function columnsOf(urgency: Urgency): readonly Column[] {
  const { columns, action } = LAYOUT[urgency];
  return action ? [...columns, action] : columns;
}

function groupsWithItems(view: DigestView): DigestViewGroup[] {
  return view.groups.filter((group) => group.items.length > 0);
}

// ---------------------------------------------------------------------------------------------
// Plain text

function textItem(item: DigestViewItem, urgency: Urgency): string {
  const header = LAYOUT[urgency].action?.header;
  const action = header && item.action ? oneLine(item.action) : '';
  const url = httpUrl(item.url);
  const lines = [
    `- ${titleOf(item)}`,
    `  What changed: ${oneLine(item.whatChanged)}`,
    ...(action ? [`  ${header}: ${action}`] : []),
    ...(url ? [`  ${url}`] : []),
  ];
  return lines.join('\n');
}

function textGroup(group: DigestViewGroup): string {
  const heading = `${LAYOUT[group.urgency].emoji} ${oneLine(group.label)}`;
  return [heading, ...group.items.map((item) => textItem(item, group.urgency))].join('\n\n');
}

/**
 * The digest as a plain-text email body: title, headline, then per urgency a heading and one
 * bullet per item (title, what changed, the action line, the URL). Model strings are put on one
 * line each and only http(s) URLs are printed, so collected text cannot fake a bullet or a link.
 */
export function renderEmailText(view: DigestView): string {
  const footer = oneLine(view.footer ?? '');
  const blocks = [
    oneLine(view.title),
    oneLine(view.headline),
    ...groupsWithItems(view).map(textGroup),
    ...(footer ? [footer] : []),
  ];
  return `${blocks.join('\n\n')}\n`;
}

// ---------------------------------------------------------------------------------------------
// HTML

/** Escapes the five characters that matter in element text and in double- or single-quoted attributes. */
function escapeHtml(text: string): string {
  return text
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

/** A model string, cleaned to one line and escaped for element text. */
function html(text: string): string {
  return escapeHtml(oneLine(text));
}

// Light palette. Every element sets its own background and text colour, so a mail client that
// darkens the message never ends up with light text on a light page or dark text on a dark one.
const COLOR = {
  page: '#f4f5f7',
  card: '#ffffff',
  text: '#1f2328',
  muted: '#57606a',
  border: '#d0d7de',
  head: '#f6f8fa',
  link: '#0550ae',
} as const;

const FONT = "-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif";
const BASE = `font-family:${FONT};color:${COLOR.text};`;

const STYLE = {
  body: `margin:0;padding:0;background-color:${COLOR.page};${BASE}`,
  outer: `width:100%;border-collapse:collapse;background-color:${COLOR.page};`,
  outerCell: `padding:24px 12px;background-color:${COLOR.page};${BASE}`,
  card: `width:100%;max-width:720px;border-collapse:separate;background-color:${COLOR.card};border:1px solid ${COLOR.border};border-radius:8px;`,
  cardCell: `padding:24px;background-color:${COLOR.card};font-size:15px;line-height:1.5;${BASE}`,
  title: `margin:0 0 8px;font-size:22px;line-height:1.3;font-weight:700;color:${COLOR.text};`,
  headline: `margin:0 0 20px;font-size:16px;color:${COLOR.muted};`,
  group: `margin:24px 0 8px;font-size:17px;line-height:1.3;font-weight:700;color:${COLOR.text};`,
  table: `width:100%;border-collapse:collapse;background-color:${COLOR.card};`,
  th: `padding:8px 10px;border-bottom:2px solid ${COLOR.border};background-color:${COLOR.head};color:${COLOR.text};font-size:13px;font-weight:700;text-align:left;vertical-align:bottom;`,
  td: `padding:10px;border-bottom:1px solid ${COLOR.border};background-color:${COLOR.card};color:${COLOR.text};font-size:14px;line-height:1.45;text-align:left;vertical-align:top;`,
  mutedTd: `padding:10px;border-bottom:1px solid ${COLOR.border};background-color:${COLOR.card};color:${COLOR.muted};font-size:14px;line-height:1.45;text-align:left;vertical-align:top;`,
  link: `color:${COLOR.link};font-weight:600;text-decoration:underline;`,
  footer: `margin:24px 0 0;padding-top:12px;border-top:1px solid ${COLOR.border};font-size:12px;color:${COLOR.muted};`,
} as const;

function htmlHeaderCell({ header, width }: Column): string {
  return `<th scope="col" align="left" width="${width}%" style="${STYLE.th}width:${width}%;">${escapeHtml(header)}</th>`;
}

function htmlRelease(item: DigestViewItem): string {
  const title = escapeHtml(titleOf(item));
  const url = httpUrl(item.url);
  const content = url
    ? `<a href="${escapeHtml(url)}" rel="noopener" style="${STYLE.link}">${title}</a>`
    : title;
  return `<td style="${STYLE.td}">${content}</td>`;
}

function htmlActionCell(item: DigestViewItem): string {
  const action = item.action ? html(item.action) : '';
  return action
    ? `<td style="${STYLE.td}">${action}</td>`
    : `<td style="${STYLE.mutedTd}">${NO_ACTION}</td>`;
}

function htmlRow(item: DigestViewItem, urgency: Urgency): string {
  const cells = [
    htmlRelease(item),
    `<td style="${STYLE.td}">${html(item.whatChanged)}</td>`,
    ...(LAYOUT[urgency].action ? [htmlActionCell(item)] : []),
  ];
  return `<tr>${cells.join('')}</tr>`;
}

function htmlGroup(group: DigestViewGroup): string {
  const head = columnsOf(group.urgency).map(htmlHeaderCell).join('');
  const rows = group.items.map((item) => htmlRow(item, group.urgency)).join('\n');
  return [
    `<h2 style="${STYLE.group}">${LAYOUT[group.urgency].emoji} ${html(group.label)}</h2>`,
    // A data table: no role="presentation", so screen readers announce the column headers.
    `<table width="100%" cellpadding="0" cellspacing="0" border="0" style="${STYLE.table}">`,
    `<thead><tr>${head}</tr></thead>`,
    `<tbody>\n${rows}\n</tbody>`,
    '</table>',
  ].join('\n');
}

/**
 * The digest as a small, self-contained HTML document: title, headline, then one table per
 * urgency. Inline styles only: no script, style block, remote image or font. Every model string
 * is escaped, and only http(s) URLs become links (with `rel="noopener"`).
 */
export function renderEmailHtml(view: DigestView): string {
  const footer = html(view.footer ?? '');
  const body = [
    `<h1 style="${STYLE.title}">${html(view.title)}</h1>`,
    `<p style="${STYLE.headline}"><em>${html(view.headline)}</em></p>`,
    ...groupsWithItems(view).map(htmlGroup),
    ...(footer ? [`<p style="${STYLE.footer}">${footer}</p>`] : []),
  ].join('\n');
  return [
    '<!doctype html>',
    '<html lang="en">',
    '<head>',
    '<meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    // Claims no dark theme of its own: every element has an explicit light background and a dark
    // text colour, and these tags tell clients not to invert them again.
    '<meta name="color-scheme" content="light dark">',
    '<meta name="supported-color-schemes" content="light dark">',
    `<title>${html(view.title)}</title>`,
    '</head>',
    `<body style="${STYLE.body}">`,
    `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="${STYLE.outer}">`,
    `<tr><td align="center" style="${STYLE.outerCell}">`,
    `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="${STYLE.card}">`,
    `<tr><td style="${STYLE.cardCell}">`,
    body,
    '</td></tr>',
    '</table>',
    '</td></tr>',
    '</table>',
    '</body>',
    '</html>',
    '',
  ].join('\n');
}
