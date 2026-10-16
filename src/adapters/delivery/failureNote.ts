import type { FailureNote } from '../../ports/Delivery.js';
import { truncate } from '../../shared/text.js';

const MAX_ONE_LINE_REASON_CHARS = 300;

/** "Weekly digest 2026-W42 failed at write" (the step part only when known). */
export function failureTitle(note: FailureNote): string {
  const where = note.step ? ` at ${note.step}` : '';
  return `Weekly digest ${note.weekId} failed${where}`;
}

/** Title plus the message squeezed onto one line and cut short, for chat. */
export function failureOneLiner(note: FailureNote): string {
  const reason = truncate(note.message.replace(/\s+/g, ' ').trim(), MAX_ONE_LINE_REASON_CHARS);
  return `${failureTitle(note)}: ${reason}`;
}
