import type { GuardVerdict } from '../guardVerdict';
import type { Item } from '../../domain/schemas';
import type { InputGuard } from '../Guard';
import {
  RULES,
  hostOf,
  isSameSite,
  sentencesOf,
  stripLinks,
  type RuleContext,
} from './ruleInjectionRules';

export interface RuleInjectionOptions {
  /** Hosts of the configured feeds. A link to them is never "off-host". */
  allowedHosts?: readonly string[];
}

/** Zero-width, bidi and deprecated format controls removed so a split word still reads as a marker. */
const INVISIBLE =
  /[\u061C\u200B-\u200F\u202A-\u202E\u2060-\u2064\u2066-\u206F\uFEFF\u00AD\u180E]/gu;

/**
 * Input guard 0: fixed patterns, no model call, no state. It flags an item when any rule in
 * `ruleInjectionRules.ts` matches its title, summary or URL. The reason names rule ids only,
 * never item text.
 */
export function createRuleInjectionGuard(options: RuleInjectionOptions = {}): InputGuard {
  const allowed = (options.allowedHosts ?? []).map((host) =>
    host.toLowerCase().replace(/^www\./, ''),
  );
  return {
    id: 'ruleInjection',
    checkItem: (item: Item): Promise<GuardVerdict> =>
      Promise.resolve(verdictFor(item, contextFor(item, allowed))),
  };
}

function contextFor(item: Item, allowed: readonly string[]): RuleContext {
  const text = `${item.title}\n${item.summary}`;
  const own = hostOf(item.url);
  return {
    item,
    raw: `${text}\n${item.url}`,
    prose: stripLinks(text.normalize('NFKC').replace(INVISIBLE, '')),
    sentences: sentencesOf(text),
    isKnownHost: (host) =>
      (own !== undefined && isSameSite(host, own)) ||
      allowed.some((known) => isSameSite(host, known)),
  };
}

function verdictFor(item: Item, context: RuleContext): GuardVerdict {
  const fired = RULES.filter((rule) => rule.matches(context)).map((rule) => rule.id);
  if (fired.length === 0) return { check: 'ruleInjection', flagged: false };
  return { check: 'ruleInjection', flagged: true, reason: `ruleInjection: ${fired.join(', ')}` };
}
