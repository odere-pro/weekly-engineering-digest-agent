# Resume a partial delivery

Part of [Runbooks](../README.md) / Recover.

## Purpose

Send the digest a week already made to the channels that missed it, with no model call and no
new digest. The channels that already have it get nothing more.

## When to use

- The week is `failed`, the error starts with `Delivery failed on`, and `Delivered:` in
  `pnpm digest show <week>` lists at least one channel (for example `markdown`).
- Nothing reached any channel: a plain `pnpm digest run` starts the week over, no resume
  needed. See [Debug a failed run](../debug/failed-run.md).
- You want a new digest for every channel: use [Re-run a week](re-run-a-week.md).

## Prerequisites

- The cause of the delivery failure is fixed ([Failed delivery](../debug/failed-delivery.md)).
- `data/runs/<week>/digest.md` still exists. A resume needs no Ollama.
- It is still the same ISO week. `digest run` always works on the current week in
  `schedule.timeZone`; it has no option to name another week.

## Steps

1. Confirm the state. The status is `failed` and `Delivered:` is shorter than your channel
   list.

   ```bash
   pnpm digest show 2026-W41
   ```

2. Run the week. Do not add `--force` or `--dry-run`: both skip the resume.

   ```bash
   pnpm digest run
   ```

3. Read what it did. The log shows `Resuming the delivery of the saved digest` with the
   channels that already had it (`deliveredTo`) and the ones it will try (`channels`), then
   `Digest delivered`. The saved Markdown is checked first: its links must be exactly the URLs
   the other channels got.
4. If it refuses, the message ends with `run with --force to send a new digest to every channel`.
   The two reasons are `The partly delivered digest.md is gone` and
   `digest.md no longer matches the digest <channels> got`. The week stays `failed`, and the
   scheduler does not retry it. A person must choose: leave it as it is, or run
   [Re-run a week](re-run-a-week.md), which sends a new digest to all channels, including the
   ones that already have the old one.
5. If one channel fails again, the week is `failed` again with a new error. `deliveredTo`
   keeps every channel that took the digest so far. Fix that channel and repeat step 2.

## Verify

```bash
pnpm digest show 2026-W41
```

The status is `sent` and `Delivered:` lists every configured channel. `<week>.md` is in the
digest folder, and `pnpm digest history -n 1` shows `sent`.

## Roll back

A message that was sent cannot be recalled. A resume does not touch the channels that already
had the digest, so there is nothing to undo there. The old run results (counts, winner, drafts)
stay in `run.json`; only the status, the start and finish times, the timings, `deliveredTo` and
the error are updated.

## Troubleshooting

| Symptom                                                | Cause                                   | Fix                                                  |
| ------------------------------------------------------ | --------------------------------------- | ---------------------------------------------------- |
| The run starts collecting and calling models           | A new week, or `deliveredTo` is empty   | Check the week id with `history`                     |
| `This week already has a sent digest. Use --force ...` | The resume already finished             | Nothing to do                                        |
| Log `Sending the saved digest without its view`        | `drafts.json` is gone or does not match | Channels get the plain Markdown; content is the same |
| Exit code 1 and `Delivery failed on slack (...)`       | The channel is still broken             | [Failed delivery](../debug/failed-delivery.md)       |
| It is a later week and the failed one was last week    | `digest run` cannot name a week         | Send `data/runs/<week>/digest.md` by hand            |

## Related

- [Delivery retries](../../operations/delivery-retries.md) and
  [Run semantics](../../architecture/run-semantics.md)
- [Force a week](../run/force-a-week.md) and [Preview a week](../run/preview-a-week.md)
- [src/digest/CLAUDE.md](../../../src/digest/CLAUDE.md)
