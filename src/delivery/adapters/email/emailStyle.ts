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

/** The inline `style` value of each element of the HTML mail. No class, no style block. */
export const STYLE = {
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
