import { checkbox, confirm, input, password, select } from '@inquirer/prompts';
import type { InitPrompts } from '../types';

/** The real questions, asked in the terminal with @inquirer/prompts. */
export const inquirerPrompts: InitPrompts = {
  confirm: (options) => confirm(options),
  checkbox: (options) => checkbox(options),
  input: (options) => input(options),
  select: (options) => select(options),
  password: (options) => password(options),
};

/** True for the error inquirer throws when the user presses Ctrl+C. */
export function isPromptCancelled(error: unknown): boolean {
  return error instanceof Error && error.name === 'ExitPromptError';
}
