# Glossary

Part of [Reference](README.md).

Terms used across the wiki, in alphabetical order. Each row links to the page that explains it.

| Term             | Meaning                                                                                              | Learn more                                                  |
| ---------------- | ---------------------------------------------------------------------------------------------------- | ----------------------------------------------------------- |
| act-now          | The most urgent of the three urgency groups: a reader should do something this week                  | [Render](../features/render.md)                             |
| adapter          | Code that plugs a real system (Ollama, a feed, SMTP, files) into a port                              | [Ports and adapters](../architecture/ports-and-adapters.md) |
| area hint        | The optional `area` of a source, passed to the classifier as a hint                                  | [Sources](../configuration/sources.md)                      |
| attack           | A fake item with an injected instruction or a bad link, used to test the guards                      | [Attacks](../evaluation/sets/attacks.md)                    |
| blocked          | Run status: drafts were written and every one was rejected. Exit code 2                              | [Exit codes](exit-codes.md)                                 |
| channel          | A way the digest is delivered: `markdown`, `email` or `slack`                                        | [Delivery](../features/delivery.md)                         |
| check            | A rule run in code on every draft: the link check and the format check. Always on                    | [Checks](../features/checks.md)                             |
| classification   | The four numbers the classifier gives an item: relevance, area, hype, minor release                  | [Classify](../features/classify.md)                         |
| composition root | The one place that turns config into real adapters (`src/app/container.ts`)                          | [App](../features/app.md)                                   |
| data dir         | The folder named by `dataDir` that holds runs, the lock and feedback                                 | [Files and paths](files-and-paths.md)                       |
| decide call      | A model call that answers typed questions (yes/no, choice, score) with probabilities                 | [Models](../features/models.md)                             |
| dedupe           | Removing items already sent in the last `dedupeWeeks` weeks, or the same release seen twice          | [Collection limits](../configuration/collection-limits.md)  |
| digest           | The weekly document of the 3 to 5 releases that matter, as Markdown, HTML, email or Slack            | [What it does](../overview/what-it-does.md)                 |
| draft            | One writer's version of the digest                                                                   | [Write](../features/write.md)                               |
| dry run          | A run started with `--dry-run`: it writes the files and sends nothing                                | [Dry run](../runbooks/run/dry-run.md)                       |
| failed           | Run status: a health check, a step or a delivery failed. Exit code 1                                 | [Exit codes](exit-codes.md)                                 |
| failure note     | A short message on every channel when a run is `failed`, `blocked` or `quiet` with nothing collected | [Exit codes](exit-codes.md)                                 |
| fallback         | The untuned model set used on a machine without Apple silicon                                        | [Profiles](../configuration/profiles.md)                    |
| feature folder   | A folder in `src/` that holds one feature: its code, tests and `CLAUDE.md`                           | [Feature folders](../architecture/feature-folders.md)       |
| focus area       | A topic your team cares about. The classifier sorts items into them                                  | [Focus areas](../configuration/focus-areas.md)              |
| forced run       | A run started with `--force`, even if the week already has a sent digest                             | [Force a week](../runbooks/run/force-a-week.md)             |
| format check     | The code check for 3 to 5 items, all fields, no em dash and under 500 words                          | [Checks](../features/checks.md)                             |
| grounded         | Backed by the source item. The groundedness guard tests it                                           | [Groundedness](../evaluation/metrics/groundedness.md)       |
| guard            | A model-based safety check on input items or output drafts. It can be switched off                   | [Guards](../configuration/guards.md)                        |
| hard gate        | An eval measure that must be 100%, or `digest eval` exits 1                                          | [Gates](../evaluation/gates.md)                             |
| held lock        | The run lock is taken by another live run, so a new run fails with exit 1                            | [Lock](../operations/lock.md)                               |
| held-out attack  | An attack case (11 to 20) never used to tune guard prompts                                           | [Attacks](../evaluation/sets/attacks.md)                    |
| item             | One collected entry from a source: title, URL, summary, date                                         | [Sources](../features/sources.md)                           |
| ISO week         | The week numbering that starts on Monday. The week id comes from it                                  | [Run semantics](../architecture/run-semantics.md)           |
| judge            | The model that scores each passing draft when there are two or more                                  | [Judge](../configuration/judge.md)                          |
| link check       | The code check that a digest holds only collected URLs                                               | [Checks](../features/checks.md)                             |
| lock             | A file, `data/digest.lock`, that lets only one run use the data dir at a time                        | [Lock](../operations/lock.md)                               |
| pipeline         | The fixed chain: collect, guardInput, classify, process, write, guardOutput, select, deliver         | [Data flow](../architecture/data-flow.md)                   |
| port             | An interface the pipeline owns and calls, such as `ModelProvider`                                    | [Ports and adapters](../architecture/ports-and-adapters.md) |
| profile          | A named set of models, one per role: `quality`, `fast` or `light`                                    | [Profiles](../configuration/profiles.md)                    |
| quiet            | Run status: nothing collected, or fewer than 3 items worth sending. Exit code 3                      | [Quiet week](../runbooks/debug/quiet-week.md)               |
| recorded week    | A past week of items frozen for evals                                                                | [Recorded weeks](../evaluation/sets/recorded-weeks.md)      |
| rejection        | A draft turned down by a check or guard. The ids are in `rejectedBy`                                 | [Run record](run-record.md)                                 |
| resume           | Finishing a partly delivered week by sending the saved digest to the missing channels                | [Run semantics](../architecture/run-semantics.md)           |
| review sheet     | `review.md`: a tick sheet for marking wrong picks and misses                                         | [Run record](run-record.md)                                 |
| role             | A job a model does: `classify`, `guardPolicy`, `guardRisk`, `write`, `judge`                         | [Models](../features/models.md)                             |
| run              | One execution of the pipeline for one week                                                           | [Run semantics](../architecture/run-semantics.md)           |
| scorecard        | The saved result of `digest eval`: one value per measure, with its gate                              | [How evals work](../evaluation/how-evals-work.md)           |
| seed             | A number sent with each model call so a rerun of a week repeats itself                               | [Models](../configuration/models.md)                        |
| sent             | Run status: the winning digest reached every channel. Exit code 0                                    | [Exit codes](exit-codes.md)                                 |
| skipped          | Run status: the week already has a sent digest. Exit code 0                                          | [Exit codes](exit-codes.md)                                 |
| soft gate        | An eval measure that shows pass or fail but does not change the exit code                            | [Gates](../evaluation/gates.md)                             |
| source           | One allowlisted feed in `sources`: an RSS or Atom feed, or a GitHub repository's releases            | [Sources](../configuration/sources.md)                      |
| stage            | A link in the run chain in `src/digest`. The `process` stage runs the item selection                 | [Digest run](../features/digest.md)                         |
| step             | A plain async function in a feature folder; the pipeline has eight                                   | [Data flow](../architecture/data-flow.md)                   |
| threshold        | A cut-off number: `minRelevance`, `maxHype`, `maxMinorRelease`, `guardFlag`                          | [Thresholds](../configuration/thresholds.md)                |
| untrusted data   | All collected text. It reaches a model only inside a labelled data block                             | [Safety](../architecture/safety.md)                         |
| urgency          | How soon to act on an item: `act-now`, `worth-a-look` or `good-to-know`                              | [Render](../features/render.md)                             |
| week id          | The ISO week of a run, for example `2026-W42`. It names the run folder                               | [Run record](run-record.md)                                 |
| window           | How many days back a run collects, set by `windowDays` or `--since`                                  | [Collection limits](../configuration/collection-limits.md)  |
| writer           | A model that drafts the digest. The list of writers is the writer panel                              | [Models](../configuration/models.md)                        |
| writer panel     | All writers of a profile, each drafting the same digest                                              | [Write](../features/write.md)                               |

## Related

- [Overview](../overview/README.md)
- [Architecture](../architecture/README.md)
- [Configuration](../configuration/README.md)
