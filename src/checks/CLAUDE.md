# Link check and format check

## Intent

Two checks in plain code that every draft must pass. The link check makes sure a digest holds only
URLs that were collected, so a model (or a prompt injected through a feed item) cannot add a link
of its own. The format check makes sure the digest has the right shape and length. A model can
break both, so neither is left to a prompt. They are always on and no config can turn them off.

## How it works

1. The write step renders a draft with `renderDigest`, then calls both checks on the digest and the
   exact Markdown. Each returns a `CheckResult` (`{ ok, problems }`, from `types.ts`).
2. `linkCheck(digest, markdown, items)` builds a set of normalized collected URLs. Then it:
   - requires every `digest.items[].url` to be a collected URL as a whole string;
   - reads the headline, intro, each item's title, area, summary, why-it-matters, action, and the
     Markdown. `linkCandidates` first decodes entities and backslash escapes the way a Markdown
     renderer does, then collects Markdown link destinations, `href` and `src` values and bare URLs;
   - reports `Unknown URL not in collected items: <url>`, `Malformed or scheme-less link: <text>`
     (`www.`, `//host`, `http:` without `//`) and `Invalid character reference: <ref>`.
3. `formatCheck(digest, markdown)` reports missing sections, urgency and action problems
   (`urgencyProblems`), a wrong item count (listed first), an em dash in the Markdown and a word
   count at or over the limit.
4. The caller maps a failing check to the id `linkCheck` or `formatCheck` in `rejectedBy`. The
   problems go to the log, to `drafts.json` and to the retry prompt.

## Design

- Always on. `CLAUDE.md` and the security rules forbid a switch. Both are pure functions with no
  I/O, no model and no logging.
- The link check decodes before it looks, so `&#104;ttp`, `&colon;` and `\` tricks cannot hide a
  URL. Item URLs must match whole after `normalizeUrl`, so nothing can follow a known prefix.
  `normalizeUrl` ignores `utm_*` and tracking params, fragments, host case and a trailing slash.
- A collected `https://www.host` URL is valid. It is removed from the text before the malformed
  link search, so its own `www.` is not flagged. Any other `www.` is rejected.
- Limits are exported constants: `DIGEST_MIN_ITEMS` 3, `DIGEST_MAX_ITEMS` 5, `DIGEST_WORD_LIMIT`
  500 (500 words or more fails), `DIGEST_MAX_ACT_NOW` 3, `DIGEST_ACTION_WORD_LIMIT` 20,
  `DIGEST_SUMMARY_WORD_LIMIT` 40. The write prompt imports them, so prompt and check cannot drift.
  The prompt aims lower (15 and 30 words, about 400 in total) to leave room.
- A word is a token with a letter or digit. Pipes, `---` rows and bullets are layout. Link
  targets `](...)` do not count. The limit holds for any table layout the renderer uses.
- The urgency rules apply only to items that have an `urgency`. A draft from before W8 passes as
  it always did. An action may never hold link-like text (`LINK_IN_TEXT`), even a collected URL.
- Missing actions are one problem for all items, so five bare items cannot fill the retry prompt.
- Regexes must stay linear on hostile text: lookbehinds for trailing punctuation, a bounded scheme
  length. Tests check run time.
- Problems quote model text. Do not put them in a prompt unmasked (`write/writePrompt.ts` does).

## Files

| File             | Role                                                                                                                           |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| `linkCheck.ts`   | `linkCheck`: every URL in the digest and Markdown must be collected                                                            |
| `formatCheck.ts` | `formatCheck` and the exported limit constants                                                                                 |
| `types.ts`       | `CheckResult`                                                                                                                  |
| `*.test.ts`      | `linkCheck.test.ts`, `linkCheck.www.test.ts`, `linkCheck.action.test.ts`, `formatCheck.test.ts`, `formatCheck.urgency.test.ts` |

## Depends on, used by

Depends on: `domain` (types), `shared/url` (`normalizeUrl`), `shared/text` (`truncate`).
Used by: `write` (both checks and the limits), `digest/runDigest.ts` (`DIGEST_MIN_ITEMS`),
`evals/metrics.ts` (both checks, `CheckResult`).

## Change it safely

- Run the five test files above, then `src/render/markdown.fixtures.test.ts` (it runs both checks
  on rendered goldens) and `src/write/writePrompt.retry.test.ts`.
- The problem prefixes `Unknown URL not in collected items: ` and `Malformed or scheme-less link: `
  are matched by `LINK_PROBLEM_KINDS` in `write/writePrompt.ts`. If you reword them, change both.
- A change to the renderer can change the word count or add link-like text. Re-run the checks.
- Do not add a config flag, an environment switch or a "skip" argument.
- A looser rule is a security change. Add a test that shows the bypass is still closed.
