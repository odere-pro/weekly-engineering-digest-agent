import type { Draft, DigestItem, GuardVerdict, Item } from '../../core/schemas.js';
import { canonicalClaimText, canonicalHeadlineText } from '../../core/canonical.js';
import { itemGuardText } from '../../core/prompts/guardQuestions.js';
import type { GuardCallOptions, InputGuard, OutputGuard } from '../../ports/Guard.js';
import type { ModelProvider } from '../../ports/ModelProvider.js';
import { truncate } from '../../shared/text.js';
import { UNTRUSTED_DATA_RULE, wrapUntrusted } from '../../shared/untrusted.js';

export interface GraniteGuardOptions {
  /** Calls generate() with role "guardRisk". */
  model: ModelProvider;
}

/**
 * granite4.1-guardian is a chat model. Its system prompt is read as the criterion to judge
 * (a risk name from its chat template, or free text); the user message is the text to judge.
 * It answers `<score>yes</score>` when the risk is present, with its reasoning in a think block
 * that Ollama may or may not split off, and gives no probabilities.
 *
 * The criteria below, except `headline`, are the model's own definitions, copied from its chat
 * template, so the data rule can sit in the same system prompt: a risk name alone leaves no room
 * for it, and putting the rule in the judged message made the groundedness verdicts worse in live
 * checks.
 */
export const GRANITE_CRITERIA = {
  jailbreak:
    "A jailbreak text refers to the deliberate evasion of an AI system's built-in safeguards or ethical boundaries. This practice often involves crafting specific prompts or scenarios intended to manipulate the AI into producing restricted or inappropriate content.",
  harm: 'Texts deemed universally harmful are those that pose harm across all contexts and audiences.',
  groundedness:
    'A text is considered ungrounded or unfaithful if it includes information lacking support from, or directly contradicting, the provided document(s). This risk arises when the text fabricates details, misinterprets the content, or makes unsupported extrapolations beyond what is explicitly stated in the document(s).',
  /**
   * Our own wording, for the digest's headline and intro (W5-11). They are editorial: they name
   * the week, count the releases and tie them together, none of which a source item says. Under
   * the generic definition above Granite flagged that framing, 5 of 10 clean controls on the
   * light profile, while the same definition on each item flagged none. This one flags what could
   * mislead a reader: a fact about a release that no document supports.
   */
  headline:
    'A text is considered ungrounded if it states a specific fact about a product or release, such as a version number, a date, a number or benchmark, a capability, a security fix or who built it, that none of the provided documents supports or that contradicts them. Editorial framing, such as naming the week, counting the releases or saying that releases are worth a look, is not a fact about a release and does not make a text ungrounded.',
} as const;

const INPUT_RISKS = ['jailbreak', 'harm'] as const;

/** Greedy answers: a guard verdict must not vary between runs. */
const GUARD_TEMPERATURE = 0;

const UNPARSABLE_REASON = 'unparsable guard output';

const THINK_CLOSE = '</think>';
const SCORE_ONLY = /^\s*<score>\s*(yes|no)\s*<\/score>\s*$/i;

/** Longest item id echoed in a reason: ids come from writer output, which is not trusted. */
const MAX_REASON_ID_CHARS = 40;

/**
 * Reads the guardian's answer: "yes" (risk present) or "no". Everything up to the last
 * `</think>` is reasoning and is dropped; what is left must be the score tag and nothing else,
 * so a tag quoted in the reasoning or echoed from the judged text cannot pass for the verdict.
 * Anything else, including a think block that never closes, is undefined.
 */
export function parseGraniteScore(text: string): 'yes' | 'no' | undefined {
  const thinkEnd = text.lastIndexOf(THINK_CLOSE);
  const answer = thinkEnd === -1 ? text : text.slice(thinkEnd + THINK_CLOSE.length);
  const score = SCORE_ONLY.exec(answer)?.[1]?.toLowerCase();
  return score === 'yes' || score === 'no' ? score : undefined;
}

/** One guardian call: criterion and data rule as the system prompt, the data as the user message. */
async function judge(
  options: GraniteGuardOptions,
  criterion: keyof typeof GRANITE_CRITERIA,
  prompt: string,
  callOptions: GuardCallOptions | undefined,
): Promise<'yes' | 'no' | undefined> {
  const { text } = await options.model.generate({
    role: 'guardRisk',
    system: `${GRANITE_CRITERIA[criterion]}\n\n${UNTRUSTED_DATA_RULE}`,
    prompt,
    temperature: GUARD_TEMPERATURE,
    ...(callOptions?.signal ? { signal: callOptions.signal } : {}),
  });
  return parseGraniteScore(text);
}

/** Input guard: granite4.1-guardian trained risks (jailbreak, harm) (W1-05). */
export function createGraniteRiskGuard(options: GraniteGuardOptions): InputGuard {
  return {
    id: 'graniteRisk',
    checkItem: (item, callOptions) => checkItemRisks(options, item, callOptions),
  };
}

/** Checks the risks in order and stops at the first one that is present or unreadable. */
async function checkItemRisks(
  options: GraniteGuardOptions,
  item: Item,
  callOptions: GuardCallOptions | undefined,
): Promise<GuardVerdict> {
  const prompt = wrapUntrusted(item.id, itemGuardText(item));
  for (const risk of INPUT_RISKS) {
    const score = await judge(options, risk, prompt, callOptions);
    if (score === undefined)
      return { check: 'graniteRisk', flagged: true, reason: UNPARSABLE_REASON };
    if (score === 'yes')
      return {
        check: 'graniteRisk',
        flagged: true,
        reason: `granite4.1-guardian flagged ${risk}`,
      };
  }
  return { check: 'graniteRisk', flagged: false };
}

/** Output guard: each digest item grounded in its source item, and the headline and intro in the cited sources (W1-05, W5-02). */
export function createGraniteGroundednessGuard(options: GraniteGuardOptions): OutputGuard {
  return {
    id: 'graniteGroundedness',
    checkDraft: (draft, sources, callOptions) =>
      checkDraftGrounding(options, draft, sources, callOptions),
  };
}

interface GroundingFindings {
  ungrounded: string[];
  unparsable: string[];
  noSource: string[];
  /** What the one headline-and-intro call found; undefined when it was not made or was fine. */
  headline?: 'ungrounded' | 'unparsable';
}

/**
 * Checks every digest item against its own source item, one call at a time, then the headline
 * and intro against all the sources the digest cites.
 */
async function checkDraftGrounding(
  options: GraniteGuardOptions,
  draft: Draft,
  sources: readonly Item[],
  callOptions: GuardCallOptions | undefined,
): Promise<GuardVerdict> {
  const sourceById = new Map(sources.map((source) => [source.id, source]));
  const findings: GroundingFindings = { ungrounded: [], unparsable: [], noSource: [] };
  const cited = new Map<string, Item>();
  for (const entry of draft.digest.items) {
    const source = sourceById.get(entry.itemId);
    if (!source) {
      findings.noSource.push(entry.itemId);
      continue;
    }
    cited.set(source.id, source);
    const score = await judge(
      options,
      'groundedness',
      groundednessPrompt(source, entry),
      callOptions,
    );
    if (score === undefined) findings.unparsable.push(entry.itemId);
    else if (score === 'yes') findings.ungrounded.push(entry.itemId);
  }
  // Without a single source there is nothing to judge them against; noSource flags the draft.
  if (cited.size > 0) {
    const score = await judge(
      options,
      'headline',
      headlinePrompt(draft, [...cited.values()]),
      callOptions,
    );
    if (score === undefined) findings.headline = 'unparsable';
    else if (score === 'yes') findings.headline = 'ungrounded';
  }
  return groundingVerdict(findings);
}

/**
 * The context (source item) and the response (summary + why it matters), each under a plain
 * header and in its own data block. Without the headers the model cannot tell which block is
 * the document and which is the text to check.
 */
function groundednessPrompt(source: Item, entry: DigestItem): string {
  const document = wrapUntrusted(`document:${source.id}`, itemGuardText(source));
  const text = wrapUntrusted(`text:${entry.itemId}`, canonicalClaimText(entry));
  return `Document:\n${document}\n\nText to check:\n${text}`;
}

/** Same layout for the headline and intro, which sum up the whole digest: every cited source is a document. */
function headlinePrompt(draft: Draft, cited: readonly Item[]): string {
  const documents = cited
    .map((source) => wrapUntrusted(`document:${source.id}`, itemGuardText(source)))
    .join('\n\n');
  const text = wrapUntrusted('text:headline', canonicalHeadlineText(draft.digest));
  return `Document:\n${documents}\n\nText to check:\n${text}`;
}

function groundingVerdict(findings: GroundingFindings): GuardVerdict {
  const ids = (list: readonly string[]): string =>
    list.map((id) => truncate(id, MAX_REASON_ID_CHARS)).join(', ');
  const parts = [
    findings.ungrounded.length > 0 && `ungrounded items: ${ids(findings.ungrounded)}`,
    findings.unparsable.length > 0 && `${UNPARSABLE_REASON} for items: ${ids(findings.unparsable)}`,
    findings.noSource.length > 0 && `no source item for: ${ids(findings.noSource)}`,
    findings.headline === 'ungrounded' && 'ungrounded headline or intro',
    findings.headline === 'unparsable' && `${UNPARSABLE_REASON} for headline and intro`,
  ].filter((part): part is string => part !== false);
  if (parts.length === 0) return { check: 'graniteGroundedness', flagged: false };
  return { check: 'graniteGroundedness', flagged: true, reason: parts.join('; ') };
}
