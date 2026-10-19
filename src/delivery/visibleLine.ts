import { printableLine } from '../shared/text';

export const ZERO_WIDTH_JOINER = '\u{200D}';

/**
 * A zero-width joiner with an emoji on each side: the only place a joiner is visible, because it
 * fuses the two into one glyph (a technologist, a family, a rainbow flag). The emoji before it may
 * carry a skin tone (`Emoji_Modifier`) or a variation selector. Anywhere else a joiner shows
 * nothing and can only hide a word break. Not global (no `lastIndex` state), so `visibleText`
 * shares it: the rule for a kept joiner lives here only.
 */
export const EMOJI_JOINER =
  /(?<=[\p{Extended_Pictographic}\p{Emoji_Modifier}]\u{FE0F}?)\u{200D}(?=\p{Extended_Pictographic})/u;

/** A stretch with no kept joiner in it: invisible characters gone, one space between words. */
function cleaned(part: string): string {
  return printableLine(part).replace(/\s+/g, ' ');
}

/**
 * Model or collected text as one line a reader sees as it is written, for Slack and email: every
 * run of whitespace, control and invisible format characters (bidi marks and overrides, zero-width
 * and tag characters, the byte order mark, the soft hyphen) becomes one space, and the ends are
 * trimmed. Collected text so cannot forge a bullet or a heading, nor reorder or hide what is
 * shown around it.
 *
 * `printableLine` covers the invisible classes, but it also removes the joiner of a joined emoji
 * and leaves a space next to a replaced character beside it, hence `cleaned`. A joiner between
 * two emoji stays, so such an emoji arrives whole. The text is cut at each kept joiner and the
 * parts are cleaned alone, so a joiner next to any other invisible character is not between
 * emoji and goes too.
 */
export function visibleLine(text: string): string {
  return text.split(EMOJI_JOINER).map(cleaned).join(ZERO_WIDTH_JOINER);
}
