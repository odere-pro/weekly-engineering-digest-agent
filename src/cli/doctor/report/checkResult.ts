export type Severity = 'ok' | 'warn' | 'error';

/** One line of the report: what was checked, what was found, and what to do about it. */
export interface CheckResult {
  severity: Severity;
  label: string;
  message: string;
  /** One line telling the user what to do; shown for warnings and errors. */
  fix?: string;
}

export const ok = (label: string, message: string): CheckResult => ({
  severity: 'ok',
  label,
  message,
});

export const warn = (label: string, message: string, fix: string): CheckResult => ({
  severity: 'warn',
  label,
  message,
  fix,
});

export const fail = (label: string, message: string, fix: string): CheckResult => ({
  severity: 'error',
  label,
  message,
  fix,
});
