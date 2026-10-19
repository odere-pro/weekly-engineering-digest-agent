/** A lock without a heartbeat (written by an older version) this old is presumed abandoned. */
export const LOCK_MAX_AGE_MS = 6 * 3_600_000;
/** A takeover is over in milliseconds; a guard this old was left behind by a crashed run. */
export const TAKEOVER_GUARD_MAX_AGE_MS = 30_000;
/** How often the holder of a lock proves it is alive. */
export const LOCK_HEARTBEAT_INTERVAL_MS = 60_000;
/** A lock whose last heartbeat is this old is presumed abandoned, on any host. */
export const LOCK_HEARTBEAT_TIMEOUT_MS = 5 * 60_000;
/**
 * A lock temp file this old was left by a run that died while writing it. A live writer needs
 * milliseconds. A writer that stalls for longer than this, or a clock that is this far from the
 * file system's, loses its temp file, and the run fails with a plain ENOENT from `link`.
 */
export const ORPHANED_TEMP_MAX_AGE_MS = 10 * 60_000;
