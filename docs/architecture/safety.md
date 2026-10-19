# Safety

Part of [Architecture](README.md).

Every collected item is untrusted web text. A feed can contain a hidden instruction, a fake
link or harmful content. These rules hold in every part of the code.

## The rules

| Rule                                                             | Enforced in                                                               |
| ---------------------------------------------------------------- | ------------------------------------------------------------------------- |
| Collected text is data: wrapped and labelled in every prompt     | `src/shared/untrusted.ts` (`wrapUntrusted`, `UNTRUSTED_DATA_RULE`)        |
| No model has tools or network access                             | the [ports](ports-and-adapters.md): models only answer                    |
| Only allowlisted hosts; same-host redirects; 5 MiB cap           | `src/sources/adapters/http.ts`                                            |
| A digest may only contain collected URLs                         | the [link check](../features/checks.md), plus URL replacement in `write`  |
| Format limits hold (3 to 5 items, under 500 words, no em dash)   | the format check                                                          |
| The link check and format check cannot be switched off           | no config key exists                                                      |
| Fixed injection rules read every item before any model does      | `src/guards/adapters/ruleInjection.ts`: no model call, first input check  |
| Guards fail closed on unparsable output                          | `src/guards/guardRun.ts`                                                  |
| Recipients, webhook and folders come from config and `.env` only | the config loader; models never supply them                               |
| Email and Slack text has no invisible character that reorders it | `src/delivery/visibleLine.ts`: format characters out, emoji joiners stay  |
| Secrets never reach logs, run records, traces or messages        | redaction in the logger, tracer, store and delivery decorators            |
| Secrets never reach the saved source data (`raw/`, `formatted/`) | the archive redacts every text it writes (`src/sources/adapters/archive`) |
| `SLACK_WEBHOOK_URL` must be `https:`                             | `src/config/schema.ts`                                                    |
| A source URL may not carry a username or password                | `src/config/schema.ts`                                                    |

## Invisible characters in delivered text

A title or a summary can carry characters that show nothing but change what a reader sees: a
bidi override (U+202E) puts the end of a line first, a bidi mark or the Arabic letter mark
(U+061C) pulls neighbouring punctuation, a zero-width space or a tag character hides text. The
email and Slack channels turn every run of control and format characters into one space before
they print model or collected text (`visibleLine`, built on `printableLine`), so one set of
characters is removed in both. One format character stays: a zero-width joiner with an emoji on
each side, which makes a joined emoji such as a technologist one glyph. A joiner anywhere else
(inside a word, doubled, next to another invisible character) is removed. Two costs: a flag with
a tag sequence (England, Scotland, Wales) shows as the plain black flag, and a zero-width
non-joiner in Persian or Indic text becomes a space. The terminal printers use `printableLine`
alone, so there a joined emoji prints as its parts.

The input side has the same list. The `ruleInjection` guard flags a bidi override, an isolate, a
deprecated format control (U+206A to U+206F) or a tag character anywhere in an item, and a
zero-width character or an Arabic letter mark (U+061C) between two Latin letters. It also drops all
of them before the phrase rules read the text, so a command split with one still matches. A real
Arabic title keeps its letter mark. See [guards](../configuration/guards.md).

## Guards are switchable, checks are not

Guards look at text before and after writing. Four ask a model; `ruleInjection` is fixed rules in
code. Config can switch each one off (see [guards configuration](../configuration/guards.md)). A
guard that is off is recorded in `run.json` and named in the digest footer, and `digest doctor`
warns about it.

The link check and the format check are plain code. They run on every draft and no setting can
turn them off.

## The fallback digest

If every writer draft is rejected, the run sends a fallback digest instead: the selected items'
own titles and first sentences, with links and other URLs taken out of the text, built by code
with no model. It passes the same link check and format check. The output guards only advise on
it, because the text is source text and there is nothing for them to ground. The input guards
(including `ruleInjection`) already filtered the items. Its footer says it was written from the
sources' own words, so a reader knows no model wrote or checked it. See
[digest run](../features/digest.md#fallback-digest).

## Layers of secret protection

1. Adapters keep secrets out of their own errors.
2. The logger and the tracer redact every string and field they write, by value.
3. The store and delivery decorators redact every record and message just before it is saved or
   sent. A record that no longer fits its schema after redaction is not saved.
4. `digest show`, `preview`, `fetch` and `doctor` strip secrets and control characters before
   they print.

The Slack webhook path counts as a secret. Redaction covers the declared secrets and the webhook
path, not a password inside `OLLAMA_URL` or the OTLP endpoint.

## Network allowlist

The agent contacts only the configured feed hosts, your Ollama, and the SMTP host and Slack
webhook you configure. A feed that redirects to another host fails its source. `GITHUB_TOKEN` is
never sent to another origin.

## Reporting a problem

If you find a way past one of these rules, treat it as a security bug: stop, fix it with a test
that shows the bypass is closed, and rotate any secret that may have leaked
([rotate secrets](../runbooks/maintain/rotate-secrets.md)).

## Related

- [Contributor security rules](../../.claude/rules/security.md)
- [Guards](../features/guards.md), [checks](../features/checks.md), [observability](../features/observability.md)
