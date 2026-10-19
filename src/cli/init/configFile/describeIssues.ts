import type { z } from 'zod';

/** One line per schema issue: `path: message`, or just the message when the value itself is wrong. */
export function describeIssues(error: z.ZodError): string {
  return error.issues
    .map((issue) => {
      const path = issue.path.join('.');
      return path === '' ? issue.message : `${path}: ${issue.message}`;
    })
    .join('\n');
}
