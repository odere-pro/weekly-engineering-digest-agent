import type { Item } from '../../domain/schemas';

/** What a rule looks at: the item, its text with and without URLs, and its links. */
export interface RuleContext {
  readonly item: Item;
  /** Title, summary and URL exactly as collected. */
  readonly raw: string;
  /** Title and summary, normalized (NFKC, zero-width removed), with every URL cut out. */
  readonly prose: string;
  /** Title and summary as sentences, URLs kept, used by the link rule. */
  readonly sentences: readonly string[];
  /** True when a host is the item's own host or an allowlisted feed host. */
  readonly isKnownHost: (host: string) => boolean;
}

export interface Rule {
  readonly id: string;
  /** The attack this rule catches. */
  readonly catches: string;
  readonly matches: (context: RuleContext) => boolean;
}

const LINK_PATTERN = /\b(?:https?:\/\/|www\.)[^\s<>()[\]"'`]+/gi;
const TRAILING_PUNCTUATION = /[.,;:!?]+$/;

/** Words that turn a link into an order. Common release-note words ("instead", "replaced") are left out. */
const LINK_DIRECTIVE =
  /\b(?:add (?:a|the) (?:link|url)|also add|include (?:a|the) (?:link|url)|use (?:that|this|the) (?:url|link)|real link|correct link|official link|webhook|recipient|tell readers|open it)\b/i;

const IGNORE_VERBS = String.raw`(?:ignore|forget|disregard)`;
const PRIOR = String.raw`(?:previous|prior|above|earlier|preceding)`;

/** Rule table. To add a rule: append one entry, then add a positive and a negative test. */
export const RULES: readonly Rule[] = [
  {
    id: 'ignorePrevious',
    catches:
      'attack-01: "ignore all (the) previous instructions" hidden in the summary. Needs a noun like instructions or rules.',
    matches: ({ prose }) =>
      new RegExp(
        String.raw`\b${IGNORE_VERBS}\s+(?:(?:all|any|the|your|of)\s+){0,3}${PRIOR}\s+(?:\w+\s+)?(?:instructions?|prompts?|rules|directions|guidelines|context|messages?)\b`,
        'i',
      ).test(prose),
  },
  {
    id: 'disregardAbove',
    catches: 'attack-11: "disregard everything above" as a second wording of the same order.',
    matches: ({ prose }) =>
      new RegExp(
        String.raw`\b${IGNORE_VERBS}\s+(?:everything|all|anything)\b[^.]{0,40}\b${PRIOR}\b`,
        'i',
      ).test(prose),
  },
  {
    id: 'ignorePreviousFr',
    catches: 'attack-20: the same order translated to French to slip past English-only filters.',
    matches: ({ prose }) => /\bignore[rz]?\s+(?:toutes\s+)?les\s+instructions\b/i.test(prose),
  },
  {
    id: 'youAreNow',
    catches: 'attack-08: "You are now DAN" persona swap. "You are now able to" is not matched.',
    matches: ({ prose }) => /\byou are now\s+(?:a|an|no longer|dan|unrestricted)\b/i.test(prose),
  },
  {
    id: 'roleLine',
    catches:
      'attack-02, attack-10: a fake "[SYSTEM]:" line, or "Assistant:" as a line or sentence start. Plain "System:" mid-sentence is not matched.',
    matches: ({ prose }) =>
      /(?:^|\n)[ \t]?(?:system|assistant|developer)\]?[ \t]?:|\[(?:system|assistant|developer)\]\s?:|[.!?]\s(?:assistant|\[system\])\s?:/i.test(
        prose,
      ),
  },
  {
    id: 'chatToken',
    catches:
      'attack-12: chat-template tokens such as <|im_start|> that fake a new turn. "<|>" is not matched.',
    matches: ({ prose }) => /<\|\s?[a-z_]{2,}/i.test(prose),
  },
  {
    id: 'delimiterBreak',
    catches:
      'attack-03, attack-17: closes our <<<DATA>>> block or the data tags, then gives orders.',
    matches: ({ prose }) =>
      /<<<\s?(?:end|begin|start|data)\b|<\/\s?(?:data|untrusted|system|instructions?)\s?>/i.test(
        prose,
      ),
  },
  {
    id: 'asAnAi',
    catches:
      '"As an AI language model ..." framing that speaks as the model. "as an AI pair programmer" is not matched.',
    matches: ({ prose }) => /\bas an ai (?:language model|assistant)\b/i.test(prose),
  },
  {
    id: 'addressesModel',
    catches:
      'attack-04, attack-18, attack-19: text that speaks to the AI reading it ("Note to AI summarizers", "To the model reading this", "Action required from the assistant").',
    matches: ({ prose }) =>
      /\b(?:note|message|attention|action required)\s(?:to|for|from)\s(?:the\s)?(?:ai|llm|model|assistant)s?\b|\bto the (?:model|llm) reading\b/i.test(
        prose,
      ),
  },
  {
    id: 'jailbreakMode',
    catches:
      'attack-13: "Developer Mode ... no restrictions" and "DAN/jailbreak mode enabled". "Developer mode enabled in Chrome" is not matched.',
    matches: ({ prose }) =>
      /\b(?:jailbreak|dan)\smode\s(?:enabled|activated)\b|\bdo anything now\b|\bdeveloper mode\b[^.]{0,30}\b(?:no restrictions|unrestricted|ignore)|\bin developer mode you\b/i.test(
        prose,
      ),
  },
  {
    id: 'encodedBlob',
    catches:
      'attack-06: instructions hidden as a base64 run of 80+ characters, or a hex run of 160+. Hex checksums up to sha512 (128) pass.',
    matches: ({ prose }) => hasBlob(prose),
  },
  {
    id: 'hiddenChars',
    catches:
      'attack-07: zero-width characters inside a word, bidi overrides, and tag characters that hide or reorder a command. A BOM, an RLM or a joiner between emoji is allowed.',
    matches: ({ raw }) => HIDDEN_CHARS.test(raw),
  },
  {
    id: 'offHostLink',
    catches:
      'attack-04, attack-05, attack-19: a link to a host that is not the item host or a feed host and sits in a sentence that orders something ("add a link", "the real link", "webhook"), or points at a public raw IP or punycode host.',
    matches: (context) => context.sentences.some((sentence) => hasOffHostLink(sentence, context)),
  },
  {
    id: 'scriptUrl',
    catches:
      'javascript:, vbscript: and data: URLs in the text or as the item URL (script injection in the delivered digest).',
    matches: ({ raw }) =>
      /\b(?:javascript|vbscript):\S|\bdata:[a-z]+\/[a-z0-9.+-]+\s?[;,]/i.test(raw),
  },
];

/** Zero-width characters between letters, bidi overrides, and tag characters (built from strings so the lint rule for joined sequences does not apply). */
// Joined with arrays so the "joined sequence" lint rule does not read the class: ZWJ is the point.
const INVISIBLE_IN_WORD = [
  '\\u200B',
  '\\u200C',
  '\\u200D',
  '\\u2060-\\u2064',
  '\\uFEFF',
  '\\u00AD',
].join('');
const BIDI_AND_TAGS = ['\\u202A-\\u202E', '\\u2066-\\u2069', '\\u{E0000}-\\u{E007F}'].join('');
// eslint-disable-next-line no-misleading-character-class
const HIDDEN_CHARS = new RegExp(`[A-Za-z][${INVISIBLE_IN_WORD}]+[A-Za-z]|[${BIDI_AND_TAGS}]`, 'u');

const HEX_RUN_LIMIT = 160;

/** A long run counts when it is not plain hex, or is hex longer than any checksum. */
function hasBlob(text: string): boolean {
  return (text.match(/[A-Za-z0-9+/]{80,}/g) ?? []).some(
    (run) => !/^[0-9a-f]+$/i.test(run) || run.length >= HEX_RUN_LIMIT,
  );
}

const PRIVATE_IP = /^(?:127\.|10\.|192\.168\.|172\.(?:1[6-9]|2\d|3[01])\.|0\.0\.0\.0$)/;

export const RULE_IDS = RULES.map((rule) => rule.id);

export function sentencesOf(text: string): string[] {
  return text.split(/(?<=[.!?])\s+|\n+/).filter((sentence) => sentence.length > 0);
}

export function stripLinks(text: string): string {
  return text.replace(LINK_PATTERN, ' ');
}

function hasOffHostLink(sentence: string, context: RuleContext): boolean {
  const ordered = LINK_DIRECTIVE.test(sentence);
  for (const match of sentence.matchAll(LINK_PATTERN)) {
    const host = hostOf(match[0].replace(TRAILING_PUNCTUATION, ''));
    if (host === undefined || context.isKnownHost(host)) continue;
    if (ordered || isHiddenHost(host)) return true;
  }
  return false;
}

/** Public raw IPs and punycode labels are how look-alike hosts are written. */
function isHiddenHost(host: string): boolean {
  if (host.includes('xn--')) return true;
  if (host.startsWith('[')) return host !== '[::1]';
  return /^\d{1,3}(?:\.\d{1,3}){3}$/.test(host) && !PRIVATE_IP.test(host);
}

export function hostOf(link: string): string | undefined {
  try {
    const url = new URL(/^www\./i.test(link) ? `https://${link}` : link);
    return url.hostname.replace(/^www\./, '').toLowerCase();
  } catch {
    return undefined;
  }
}

/** The link host is the known host or a sub-domain of it (docs.acme.example of acme.example). */
export function isSameSite(host: string, known: string): boolean {
  return host === known || host.endsWith(`.${known}`);
}
