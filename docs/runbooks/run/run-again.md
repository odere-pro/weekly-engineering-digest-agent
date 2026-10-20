# Run again

Part of [Runbooks](../README.md) / Run.

## Purpose

Make a second digest for a week that already has one, without starting from scratch. The second
run reuses the items the first run saved, builds a copy with a postfix in its name, and asks if you
want to send it. The week's own digest is not touched.

## When to use

- You want more items in the digest: fetch the sources again (`--enrich`) or add new sources
  (`--add-source`).
- You want every release that passed the filters, not only the top ones (`--complete`).
- You want the same week seen from another angle, such as `security` (`--perspective`).
- To replace the week's digest and send it again to everyone, use
  [Force a week](force-a-week.md).
- To try a week without sending, use [Dry run](dry-run.md).

## Prerequisites

- The week has a run record that is `sent` or `dry-run`, and a saved `items.json` in
  `dist/<monday>/digest/`. Without `items.json` the run stops and says to run the week once first.
- A green `digest doctor`. The models run, so a variant takes minutes, not seconds.
- No other run in progress (the run lock).
- Email and Slack recipients get the variant if you say yes. A sent message cannot be recalled.

## Steps

### The menu

A second `digest run` in a week that is `sent` or `dry-run` opens a menu. It appears only when
stdin and stdout are a terminal and `--force` is not given. It does not appear when:

- the output is piped, or the run is in Docker without a terminal (a script, cron, `serve`);
- you pass `--force` or any of the four variant flags;
- the week has no earlier digest, or the record is `failed`, `blocked` or `quiet`.

In those cases the run behaves as before. `Skip` (the default, Enter) does too: a sent week ends
`skipped`, a dry-run week runs in full.

```bash
pnpm digest run
```

| Choice                               | What it fetches             | What it changes                                                         | File it writes                 |
| ------------------------------------ | --------------------------- | ----------------------------------------------------------------------- | ------------------------------ |
| Rerun to enrich digest               | Every source, merged by URL | Saved items plus the new ones go through the whole chain                | `<week>-enriched.md`           |
| Add sources and enrich digest        | Only the sources you add    | Asks for URLs; saved items plus the new ones go through the chain       | `<week>-enriched.md`           |
| Generate complete digest with events | Nothing                     | The normal digest, plus a list of every release that passed the filters | `<week>-complete.md`           |
| Rerun with new perspective           | Nothing                     | Asks for a topic; the classifier and the writers favour it              | `<week>-perspective-<slug>.md` |
| Skip                                 | Nothing                     | Nothing                                                                 | None                           |

Each variant file has an `.html` twin. The slug is the topic in lower case with `-` between words,
at most 40 characters.

Details:

- Items from the first digest keep their place when scores tie, so the variant stays close to it.
- The list in `complete` is grouped by area. It is built from the item text only, never by a model,
  and it is in the message only, never in `digest.md`.
- Added sources are used for this run only. In a terminal you are asked if the config file should
  keep them. Without a terminal nothing is saved and a one-line hint says so.
- The topic is one line of 1 to 200 characters, without `"`.

### The flags

The same four choices work without the menu, for scripts and Docker. Use one at a time; two
together is an error that names them.

```bash
pnpm digest run --enrich
pnpm digest run --complete
pnpm digest run --perspective security
pnpm digest run --add-source https://example.com/feed.xml https://github.com/example/runner
```

Docker: `docker compose run --rm digest run --perspective security`.

Flags work for any earlier record as long as `items.json` exists. They combine with `--since`,
`--seed`, `--out` and `--dry-run`.

### The send question

The variant is always built on disk first. The files are written even if you do not send.

- In a terminal: `Send to email, slack?` The default is no. Nothing is asked when only the
  Markdown file is configured.
- Without a terminal: a variant flag counts as the yes. The variant goes to every configured
  channel except the Markdown file.
- With `--dry-run`: nothing is sent and nothing is asked. Only the files are written.

### What happens to run.json

| Week was | You say no (or `--dry-run`)                        | You say yes                                                                                  |
| -------- | -------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| `sent`   | Record unchanged                                   | Stays `sent`; gains the channels and URLs that went out and `variant` (kind, topic, sources) |
| dry-run  | Record unchanged (a dry-run week keeps its status) | Becomes `sent`; `variant` is set                                                             |

`variant` is how you tell that a sent record was last touched by a variant: `show` prints a
`Variant:` line and `history` adds `*` after the status.

## Verify

- Exit code 0. The summary names the variant (`enriched`, `complete` or `perspective: <topic>`).
- The variant files exist next to `<week>.md`, in `delivery.markdown.dir` or in
  `dist/<monday>/digest/`.
- `<week>.md` is unchanged.
- After a yes: the run prints `Sent to <channels>.`, `pnpm digest show <week>` has a `Variant:` line
  and `Delivered:` names the channels, and `pnpm digest history` marks the week with `*`.

## Roll back

Delete the `<week>-<variant>.md` and `.html` files. A message that was sent cannot be recalled.
`variant` in run.json stays; the week's own files are not affected.

## Troubleshooting

| Symptom                                                 | Cause                                                | Fix                                                                                |
| ------------------------------------------------------- | ---------------------------------------------------- | ---------------------------------------------------------------------------------- |
| The menu does not appear                                | No terminal, `--force`, or no sent or dry-run digest | Use a flag, or see the list above.                                                 |
| `Use only one of --enrich, --complete, ...`             | Two variant flags                                    | Pass one.                                                                          |
| `No saved items for <week>`                             | `items.json` is missing                              | Run the week once without a variant first.                                         |
| `Error: ... Not sent to: slack. Run it again to retry.` | Part of the send failed; exit 1                      | Run the same variant again. A partly failed variant is not resumed by a plain run. |
| `Cancelled. Nothing was run.`                           | Ctrl+C in a menu question; exit 1                    | Run again.                                                                         |
| `show` or `preview` show the first digest               | They read the week's own run files                   | See the risks below. Open the variant `.md` or `.html` file.                       |
| Exit 2 or 3, `No <variant> digest was built`            | Every draft was rejected, or too few items qualified | [Blocked run](../debug/blocked-run.md), [Quiet week](../debug/quiet-week.md).      |

Risks:

- A variant that stays on disk, on a week that is `sent`, leaves only its `.md` and `.html` files.
  The run files (`drafts.json`, `scores.json`) of the variant are dropped, so `show` and `preview`
  keep showing the week's own run.
- A sent variant marks the record with `variant`, but the counts, the winner and the draft list
  are still the first run's. A record per variant would need a new store layout.
- `prune` keeps the variant files while it keeps the week's own.

## Related

- [Run now](run-now.md), [Dry run](dry-run.md), [Force a week](force-a-week.md)
- [Resume a partial delivery](../recover/resume-partial-delivery.md)
- [src/cli/run/again/CLAUDE.md](../../../src/cli/run/again/CLAUDE.md)
