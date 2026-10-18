import { mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { WEEK_ID_PATTERN } from '../../domain/schemas';
import type { Delivery, DigestMessage, FailureNote } from '../Delivery';
import { writeFileAtomic } from '../../store/adapters/atomicFile';
import { renderEmailHtml } from './emailRender';
import { failureTitle } from './failureNote';

export interface MarkdownFileOptions {
  dir: string;
}

/** The files one week's digest is written to. */
export interface DigestFilePaths {
  markdown: string;
  /** Written only for a digest that carries its laid-out view. */
  html: string;
}

/** The week id becomes a file name, so only a real ISO week id (2026-W42) is allowed. */
function assertWeekId(weekId: string): void {
  if (!WEEK_ID_PATTERN.test(weekId)) {
    throw new Error(`Cannot deliver to a file: invalid week id ${JSON.stringify(weekId)}`);
  }
}

/** `<dir>/<weekId>.md` and `<dir>/<weekId>.html`; throws for anything but an ISO week id. */
export function digestFilePaths(dir: string, weekId: string): DigestFilePaths {
  assertWeekId(weekId);
  return { markdown: join(dir, `${weekId}.md`), html: join(dir, `${weekId}.html`) };
}

function failureMarkdown(note: FailureNote): string {
  const step = note.step ? `- Step: ${note.step}\n` : '';
  return `# ${failureTitle(note)}\n\n${step}- Error: ${note.message}\n`;
}

/**
 * Always-on delivery: writes <dir>/<weekId>.md (W1-12) and, when the message carries its view,
 * <dir>/<weekId>.html (W8-05), the same page the email channel sends, so the digest opens in a
 * browser. A digest without a view removes the week's old .html: the two files never disagree.
 */
export function createMarkdownFileDelivery(options: MarkdownFileOptions): Delivery {
  async function ensureDir(): Promise<void> {
    await mkdir(options.dir, { recursive: true });
  }

  async function sendDigest(message: DigestMessage): Promise<void> {
    const paths = digestFilePaths(options.dir, message.weekId);
    // Rendered before anything is written, so a render failure leaves the folder as it was.
    const html = message.view === undefined ? undefined : renderEmailHtml(message.view);
    await ensureDir();
    // The old HTML goes first: if a later write fails, the folder never pairs the new Markdown
    // with a page of an earlier run.
    await rm(paths.html, { force: true });
    await writeFileAtomic(paths.markdown, message.markdown);
    if (html !== undefined) await writeFileAtomic(paths.html, html);
  }

  async function sendFailure(note: FailureNote): Promise<void> {
    assertWeekId(note.weekId);
    await ensureDir();
    await writeFileAtomic(join(options.dir, `${note.weekId}.failed.md`), failureMarkdown(note));
  }

  return { id: 'markdown', sendDigest, sendFailure };
}
