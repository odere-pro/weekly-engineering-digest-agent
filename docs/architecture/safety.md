# Safety

Part of [Architecture](README.md).

Every collected item is untrusted web text. A feed can contain a hidden instruction, a fake
link or harmful content. These rules hold in every part of the code.

## The rules

| Rule                                                             | Enforced in                                                              |
| ---------------------------------------------------------------- | ------------------------------------------------------------------------ |
| Collected text is data: wrapped and labelled in every prompt     | `src/shared/untrusted.ts` (`wrapUntrusted`, `UNTRUSTED_DATA_RULE`)       |
| No model has tools or network access                             | the [ports](ports-and-adapters.md): models only answer                   |
| Only allowlisted hosts; same-host redirects; 5 MiB cap           | `src/sources/adapters/http.ts`                                           |
| A digest may only contain collected URLs                         | the [link check](../features/checks.md), plus URL replacement in `write` |
| Format limits hold (3 to 5 items, under 500 words, no em dash)   | the format check                                                         |
| The link check and format check cannot be switched off           | no config key exists                                                     |
| Guards fail closed on unparsable output                          | `src/guards/guardRun.ts`                                                 |
| Recipients, webhook and folders come from config and `.env` only | the config loader; models never supply them                              |
| Secrets never reach logs, run records, traces or messages        | redaction in the logger, tracer, store and delivery decorators           |
| `SLACK_WEBHOOK_URL` must be `https:`                             | `src/config/schema.ts`                                                   |
| A source URL may not carry a username or password                | `src/config/schema.ts`                                                   |

## Guards are switchable, checks are not

Guards are models that look at text before and after writing. Config can switch each one off
(see [guards configuration](../configuration/guards.md)). A guard that is off is recorded in
`run.json` and named in the digest footer, and `digest doctor` warns about it.

The link check and the format check are plain code. They run on every draft and no setting can
turn them off.

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
