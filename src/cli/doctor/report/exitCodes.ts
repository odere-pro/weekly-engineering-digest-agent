/** Exit codes of `digest doctor` and `digest doctor --readiness`. They are public: do not renumber. */
export const EXIT_OK = 0;
/** Doctor: at least one check is an error. */
export const EXIT_FAILED = 1;
/** Readiness: no profile can run on this machine. */
export const EXIT_NONE_FIT = 1;
