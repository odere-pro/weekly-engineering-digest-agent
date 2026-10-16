---
paths:
  - 'src/**'
  - 'evals/**'
---

# Security invariants (from the spec)

Every collected item is untrusted web text. These hold in every change:

1. **Data, not instructions.** Item text reaches a model only inside `wrapUntrusted()` blocks,
   with `UNTRUSTED_DATA_RULE` in the system prompt. No model has tools or network access.
2. **Link check and format check always run** on every draft, in code. No config can turn
   them off. A digest may only contain URLs that exist in the collected items.
3. **Fixed recipients.** Email addresses, Slack webhooks and file paths come from config and
   `.env` only, never from model output.
4. **Network allowlist.** Contact only the configured feed hosts, the Ollama URL and the
   configured delivery endpoint.
5. **Secrets** (`SMTP_PASSWORD`, `SLACK_WEBHOOK_URL`, `GITHUB_TOKEN`) never appear in logs,
   run records, traces, errors or test snapshots. Redact before logging.
6. **Guards are switchable, checks are not.** A disabled guard is recorded in `run.json` and
   named in the digest footer.
7. **Supply chain.** No new dependencies on issue branches; versions are pinned in the lockfile.
