# Re-run a week

Part of [Runbooks](../README.md) / Recover.

## Purpose

Run the current week again from the start, with new model calls, and send a new digest to every
channel. Use it when the week already has a sent digest, or when a resume is refused.

## When to use

- The digest was sent but is wrong, and you have fixed the cause (config, thresholds, models).
- A resume refused with a message that contains `--force`.
- Not needed when the week is `failed`, `blocked` or `quiet` and nothing was sent: a plain
  `pnpm digest run` runs it again. Not needed when only a channel missed the digest: use
  [Resume a partial delivery](resume-partial-delivery.md).

## Prerequisites

- `pnpm digest doctor` is green and Ollama is running.
- You accept that every channel gets a second digest. Tell the readers first.
- It is the same ISO week as the run you want to replace. `digest run` takes the current week
  in `schedule.timeZone` and has no option for another one.
- Copy `data/runs/<week>/` to a place outside `data/runs/` if you may want the old digest back.

## Steps

1. Check what the week has now.

   ```bash
   pnpm digest show 2026-W43
   ```

2. Optional: exercise the run without any effect. A forced dry run of a sent week sends
   nothing and keeps the sent record and files, so you see only the summary and a line
   `Kept the sent run record; this forced run did not end sent.`

   ```bash
   pnpm digest run --force --dry-run
   ```

3. Run it for real. `--force` skips the "already sent" check and the resume, so the whole
   pipeline runs.

   ```bash
   pnpm digest run --force
   ```

   Add `--since 14d` to change the window, or `--seed 7` to change the sampling (see below).

4. Know what the run keeps. A run never replaces a record that got further:
   - Earlier record `sent`: it is replaced only if the new run also ends `sent`. In any other
     case the sent record and its files in the run folder stay, and the summary says why.
   - Earlier record partly delivered: it is replaced once the new run reaches a channel, and it
     stays if the new run delivers nothing.
   - Any other earlier record (`quiet`, `blocked`, `failed`, `dry-run`): it is replaced.

   A forced run that fails or is blocked still sends its failure note.

5. Know the repeat behaviour. The seed (`models.seed`, default 42) goes with every generate
   call, and `write` uses temperature 0.2, so a repeat is likely but not guaranteed to match.
   `--seed <n>` (a whole number of 0 or more) asks for a different sample. The cross-week dedupe
   looks only at the `dedupeWeeks` weeks before this one, never at this week. A forced re-run
   can therefore pick the same items again.

## Verify

```bash
pnpm digest show 2026-W43
```

`Started:` is the time of the new run, the status is `sent`, and `Delivered:` lists every
channel. If the summary says `Kept the sent run record`, the old digest stands.

## Roll back

A message that was sent cannot be recalled. If the new run replaced the files and you want the
old ones, copy the saved run folder back into `data/runs/` while no run is going. Nothing else
needs undoing.

## Troubleshooting

| Symptom                                                             | Cause                                | Fix                                          |
| ------------------------------------------------------------------- | ------------------------------------ | -------------------------------------------- |
| `This week already has a sent digest. Use --force to run it again.` | `--force` was left out               | Add `--force`                                |
| `Kept the sent run record; this forced run did not end sent`        | The new run did not end `sent`       | Read the status in the summary; fix; repeat  |
| `Another run is in progress (pid ..., week ...)`                    | Another run holds the lock           | [Stuck lock](../debug/stuck-lock.md)         |
| The same items came back                                            | Dedupe ignores the week being re-run | Change thresholds, focus areas or `--seed`   |
| A failure note arrived after a forced run                           | The run failed or was blocked        | The sent digest stands if `Kept` was printed |

## Related

- [Force a week](../run/force-a-week.md) and [Dry run](../run/dry-run.md)
- [Run semantics](../../architecture/run-semantics.md) and [Exit codes](../../reference/exit-codes.md)
- [src/digest/CLAUDE.md](../../../src/digest/CLAUDE.md)
