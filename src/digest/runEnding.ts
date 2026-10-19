// The ending of a run lives in ending/. These re-exports keep the callers outside src/digest
// working until they import from the new files.
export { RecordNotSavedError } from './ending/saveRecord'; // compat (W10-B23): remove when callers move
export { KEPT_SENT_REASON } from './ending/keepReason'; // compat (W10-B23): remove when callers move
export { sendHeldNote } from './ending/notes/failureNotes'; // compat (W10-B23): remove when callers move
export { isUnretriable, needsForce } from './ending/notes/unretriable'; // compat (W10-B23): remove when callers move
export { DraftsFileSchema, toJson } from './ending/runFiles/runFiles'; // compat (W10-B23): remove when callers move
