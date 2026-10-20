const MARKDOWN_LINK = /\]\(https?:\/\/[^)\s]+\)/g;

/** The URLs of the `[text](url)` links in a Markdown digest, without repeats, in order. */
export function linkUrls(markdown: string): string[] {
  const links = markdown.match(MARKDOWN_LINK) ?? [];
  return [...new Set(links.map((link) => link.slice(2, -1)))];
}
