import type {
  DigestAppendix,
  DigestAppendixItem,
  DigestView,
  DigestViewGroup,
  DigestViewItem,
} from '../../../render/digestView';
import {
  columnsOf,
  groupsWithItems,
  LAYOUT,
  NO_ACTION,
  type Column,
  type Urgency,
} from './emailLayout';
import { STYLE } from './emailStyle';
import { escapeHtml, httpUrl, oneLine, titleOf } from './safeText';
import { withVariant } from './variantTitle';

/** A model string, cleaned to one line and escaped for element text. */
function html(text: string): string {
  return escapeHtml(oneLine(text));
}

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

function htmlAppendixItem(item: DigestAppendixItem): string {
  const title = escapeHtml(titleOf(item));
  const url = httpUrl(item.url);
  const link = url
    ? `<a href="${escapeHtml(url)}" rel="noopener" style="${STYLE.link}">${title}</a>`
    : title;
  return `<li>${link}: ${html(item.line)}</li>`;
}

/** One heading, then a heading and a list per area. */
function htmlAppendix(appendix: DigestAppendix): string {
  const groups = appendix.groups
    .filter((group) => group.items.length > 0)
    .map((group) =>
      [
        `<h3 style="${STYLE.area}">${html(group.area)}</h3>`,
        `<ul style="${STYLE.list}">`,
        ...group.items.map(htmlAppendixItem),
        '</ul>',
      ].join('\n'),
    );
  return [`<h2 style="${STYLE.group}">${html(appendix.title)}</h2>`, ...groups].join('\n');
}

/**
 * The digest as a small, self-contained HTML document: title, headline, then one table per
 * urgency. Inline styles only: no script, style block, remote image or font. Every model string
 * is escaped, and only http(s) URLs become links (with `rel="noopener"`).
 */
export function renderEmailHtml(view: DigestView): string {
  const footer = html(view.footer ?? '');
  const title = html(withVariant(view));
  const body = [
    `<h1 style="${STYLE.title}">${title}</h1>`,
    `<p style="${STYLE.headline}"><em>${html(view.headline)}</em></p>`,
    ...groupsWithItems(view).map(htmlGroup),
    ...(footer ? [`<p style="${STYLE.footer}">${footer}</p>`] : []),
    ...(view.appendix ? [htmlAppendix(view.appendix)] : []),
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
    `<title>${title}</title>`,
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
