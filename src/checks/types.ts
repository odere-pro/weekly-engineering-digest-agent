export interface CheckResult {
  ok: boolean;
  /** Human-readable problems; empty when ok. */
  problems: string[];
}
