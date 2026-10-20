import type { Config } from '../../../config/schema';
import { printableLine } from '../../../shared/text';
import type { RunPrompts } from './types';

export interface SuggestedPerspective {
  readonly name: string;
  readonly description: string;
}

// TODO: import `TOPICS` from src/sources/topics/catalog.ts and drop this list once that catalog lands.
export const SUGGESTED_PERSPECTIVES: readonly SuggestedPerspective[] = [
  { name: 'AI agents', description: 'Agent frameworks, SDKs and coding agents that shipped' },
  { name: 'AI and LLM updates', description: 'New models and lab announcements' },
  {
    name: 'Agentic system design',
    description: 'How to build agentic systems: patterns and architecture',
  },
  { name: 'LLM and agent evaluations', description: 'Eval tools, benchmarks and methods' },
];

const TOPIC_MAX = 200;
const OWN_TOPIC = '__type-your-own__';

/** The suggested topics, then the config's focus areas that are not among them (case-insensitive). */
export function suggestedPerspectives(
  config: Pick<Config, 'focusAreas'>,
): readonly SuggestedPerspective[] {
  const seen = new Set(SUGGESTED_PERSPECTIVES.map((topic) => topic.name.toLowerCase()));
  const own = config.focusAreas
    .filter((area) => !seen.has(area.toLowerCase()))
    .map((area) => ({ name: area, description: 'A focus area from your config' }));
  return [...SUGGESTED_PERSPECTIVES, ...own];
}

/** Terminal text as a topic: one printable line, no double quotes, 1-200 characters; else `undefined`. */
export function cleanTopic(text: string): string | undefined {
  const topic = printableLine(text.replaceAll('"', ''));
  return topic.length >= 1 && topic.length <= TOPIC_MAX ? topic : undefined;
}

/** The topic for this week's run: a suggestion, or free text after "Type your own…". */
export async function askPerspective(
  prompts: RunPrompts,
  config: Pick<Config, 'focusAreas'>,
): Promise<string> {
  const suggestions = suggestedPerspectives(config);
  const picked = await prompts.select<string>({
    message: "This week's perspective",
    choices: [
      ...suggestions.map((topic) => ({
        name: topic.name,
        value: topic.name,
        description: topic.description,
      })),
      { name: 'Type your own…', value: OWN_TOPIC },
    ],
    default: suggestions[0]?.name ?? OWN_TOPIC,
  });
  if (picked !== OWN_TOPIC) return picked;
  const typed = await prompts.input({
    message: 'Topic',
    validate: (value) =>
      cleanTopic(value) !== undefined || `Enter a topic of 1 to ${String(TOPIC_MAX)} characters`,
  });
  return cleanTopic(typed) ?? typed.trim();
}
