# Checks

Part of [Features](README.md).

## What it is for

Two checks in plain code that every draft must pass. The link check makes sure a digest holds only
URLs that were collected, so a model (or an instruction hidden in a feed item) cannot add a link
of its own. The format check makes sure the digest has the right shape and length. A model can
break both, so neither is left to a prompt. They are always on, and no setting can turn them off.

## Where it sits

They run inside the write step, on every draft, before the output guards. See
[data flow](../architecture/data-flow.md).

## What it does

- Link check: every item URL must be one of the collected URLs, compared after normalising (case
  of the host, a trailing slash, tracking parameters and fragments are ignored).
- It also reads the headline, the intro, every item field and the Markdown. It decodes character
  references and backslash escapes first, the way a Markdown renderer does, so tricks such as
  `&#104;ttp` cannot hide a URL.
- It rejects an unknown URL, a scheme-less link (`www.`, `//host`, `http:` without `//`) and an
  invalid character reference. A collected `https://www.host` URL is fine. An action line may hold
  no link-like text at all, not even a collected URL.
- Format check: 3 to 5 items; a headline, an intro and, for each item, a summary and a
  why-it-matters line; no em dash; fewer than 500 words in the Markdown (500 or more fails).
- For items with an urgency: at most 3 "act now" items, an action line on every "act now" and
  "worth a look" item, an action of at most 20 words and a summary of at most 40 words. The writer
  is asked for less (15 and 30 words), so a draft that runs a little long still passes.
- A word is a token with a letter or digit. Table pipes, `---` rows, bullets and link targets do
  not count.
- A failing check puts `linkCheck` or `formatCheck` in the draft's `rejectedBy` list. The problems
  go to the log, to `drafts.json` and, with links masked, into the retry prompt.

## What you can configure

- Nothing. There is no setting, environment variable or flag for either check. This is a security
  rule: see [safety](../architecture/safety.md).
- The limits are constants in code. Changing them is a code change. The write prompt reads the
  same constants, so prompt and check stay in step.
- To get fewer rejections, change the writers or their settings instead. See
  [write](write.md) and [change models or writers](../runbooks/configure/change-models-or-writers.md).

## What can go wrong

- Every draft fails a check, even after the retry: the week is `blocked` (exit 2). The note and
  `run.json` name each writer and the check ids. See
  [blocked run](../runbooks/debug/blocked-run.md).
- A repeating `formatCheck` rejection usually means a writer that runs long or adds an em dash.
  Read the problems under `rejections` in `drafts.json`. A repeating `linkCheck` rejection means
  the writer invents or mangles a link.
- Never try to switch the checks off to get a digest out. Run again, or change the writers.
- Measures: [link validity](../evaluation/metrics/link-validity.md) and
  [format](../evaluation/metrics/format.md). Both are hard gates in the evals.

## Code and tests

- Folder: [src/checks/](../../src/checks/). Maintainer notes: [CLAUDE.md](../../src/checks/CLAUDE.md).
- No port and no adapters. Both checks are pure functions with no I/O and no model call.
- Tests sit next to the code. They include run-time checks for hostile text and a test that renders
  the golden digests and runs both checks on them.

## Related

- [write](write.md) calls the checks and retries once. [render](render.md) produces the Markdown
  they read.
- [guards](guards.md) are the model-based checks that can be switched off. These two cannot.
- The same checks judge digests in [evals](evals.md).
