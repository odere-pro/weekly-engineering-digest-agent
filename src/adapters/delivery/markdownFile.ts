import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { WEEK_ID_PATTERN } from '../../core/schemas.js';
import type { Delivery, FailureNote } from '../../ports/Delivery.js';
import { writeFileAtomic } from '../store/atomicFile.js';
import { failureTitle } from './failureNote.js';

export interface MarkdownFileOptions {
  dir: string;
}

/** The week id becomes a file name, so only a real ISO week id (2026-W42) is allowed. */
function assertWeekId(weekId: string): void {
  if (!WEEK_ID_PATTERN.test(weekId)) {
    throw new Error(`Cannot deliver to a file: invalid week id ${JSON.stringify(weekId)}`);
  }
}

function failureMarkdown(note: FailureNote): string {
  const step = note.step ? `- Step: ${note.step}\n` : '';
  return `# ${failureTitle(note)}\n\n${step}- Error: ${note.message}\n`;
}

/** Always-on delivery: writes <dir>/<weekId>.md (W1-12). */
export function createMarkdownFileDelivery(options: MarkdownFileOptions): Delivery {
  async function write(fileName: string, weekId: string, content: string): Promise<void> {
    assertWeekId(weekId);
    await mkdir(options.dir, { recursive: true });
    await writeFileAtomic(join(options.dir, fileName), content);
  }

  return {
    id: 'markdown',
    sendDigest: (message) => write(`${message.weekId}.md`, message.weekId, message.markdown),
    sendFailure: (note) => write(`${note.weekId}.failed.md`, note.weekId, failureMarkdown(note)),
  };
}
