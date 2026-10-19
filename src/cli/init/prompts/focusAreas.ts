import { ConfigSchema } from '../../../config/schema';
import { DEFAULT_FOCUS_AREAS } from '../../../sources/defaultSources';
import { describeIssues } from '../configFile/describeIssues';
import type { InitPrompts } from '../types';
import { splitList } from './validate';

const FocusAreasSchema = ConfigSchema.shape.focusAreas;

/** The defaults pre-ticked, then a free-text line for more. The line is checked as it is typed. */
export async function askFocusAreas(prompts: InitPrompts): Promise<string[]> {
  const picked = await prompts.checkbox({
    message: 'Focus areas (space to toggle, enter to confirm)',
    choices: DEFAULT_FOCUS_AREAS.map((area) => ({ name: area, value: area, checked: true })),
  });
  const typed = await prompts.input({
    message: 'Other focus areas (comma-separated, optional)',
    validate: (value) => focusAreasProblem(mergeFocusAreas(picked, value)) ?? true,
  });
  return mergeFocusAreas(picked, typed);
}

/** Trimmed, non-empty, unique ignoring case; the first spelling wins. */
export function mergeFocusAreas(picked: readonly string[], typed: string): string[] {
  const seen = new Set<string>();
  return [...picked, ...splitList(typed)].flatMap((area) => {
    const name = area.trim();
    const key = name.toLowerCase();
    if (name === '' || seen.has(key)) return [];
    seen.add(key);
    return [name];
  });
}

/** Why the config schema would refuse this list (empty, over 25), or undefined when it would not. */
export function focusAreasProblem(areas: string[]): string | undefined {
  const result = FocusAreasSchema.safeParse(areas);
  return result.success ? undefined : `Focus areas: ${describeIssues(result.error)}`;
}
