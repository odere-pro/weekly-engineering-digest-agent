# Known limits

Part of [Operations](README.md).

The honest list. Each item says what happens and why.

## Quality

- Only the `light` profile is measured. Format is at 83% on its baseline (one recorded week
  produced no digest on its first replay). See [results](../evaluation/results.md).
- The thresholds were tuned on `light` only.
- The groundedness guard can block good drafts, in particular on the headline and intro.
- Same-release dedupe is narrow on purpose. The same story from two feeds can get through when
  one title has no version.
- The link check ignores autolinks with a scheme other than `http(s)`, and accepts a collected
  URL with extra tracking parameters or a fragment.

## Running

- One replica. The lock is a file on local disk. Two machines sharing `data/` over a network file
  system are not supported, and `data/` needs hard links (not FAT, exFAT or some SMB shares).
- A run suspended for more than 5 minutes (a sleeping laptop) can lose its lock to another run.
- The abort signal is checked between steps only. A hanging model call holds a run until its
  timeout.
- Delivery is at least once. A message can arrive twice when a server took it and then reported
  an error.

## Feeds

- GitHub keeps 10 releases per Atom feed, so a busy week can lose some.
- A source that returns nothing is logged, not recorded in `run.json`.
- There is no official Anthropic or Meta AI feed.

## Secrets

- Redaction covers the declared secrets and the Slack webhook path, not a password inside
  `OLLAMA_URL` or the OTLP endpoint.

## Related

- [Status and limits](../overview/status-and-limits.md), [triage](triage.md)
