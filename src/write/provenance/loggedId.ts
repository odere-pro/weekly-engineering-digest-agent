import { truncate } from '../../shared/text';

/** Item ids in logs come from model output; keep them short. */
const LOGGED_ID_MAX_CHARS = 80;

export function loggedId(itemId: string): string {
  return truncate(itemId, LOGGED_ID_MAX_CHARS);
}
