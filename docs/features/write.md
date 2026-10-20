# Write

Part of [Features](README.md).

## What it is for

A panel of writer models each drafts the weekly digest from the top items. Models make mistakes
that matter here: wrong links, repeated items, em dashes, a wrong format. This step limits what a
writer can get wrong, fixes the small faults in code, runs the link check and the format check,
and gives each writer one retry when no draft passes.

## Where it sits

It is the sixth step, after guardCandidates. The checks run inside it, and the output guards and
the judge follow. See [data flow](../architecture/data-flow.md).

## What it does

- Needs at least 3 items. With fewer it calls no writer.
- Runs the writers one after another, in config order, because only one model fits in memory. Each
  gets the same prompt and returns structured data: headline, intro, and for each item a title, a
  summary, why it matters, an urgency and an action line. An invalid reply gets one repair call.
- The model can name an item but never choose its link. Unknown and repeated item ids are dropped
  and every URL is replaced with the collected item's own URL.
- Fixes small faults in code: keeps at most `topN` items, replaces em dashes, adds `https://` to a
  scheme-less link that names a collected URL, and cuts an action to 200 characters.
- Raises a "good to know" item to "worth a look", with a fixed action, when its collected source
  names a CVE, a GHSA id, an advisory or a vulnerability. It never raises an item higher.
- Replaces a title with the item's own source title when the title names a version, a CVE or GHSA
  id or a date that the source's title and summary do not have. The title is the link text and the
  groundedness guard does not read it. A shorter version is fine ("1.31" for "v1.31.2"), but a
  pre-release must match ("1.17" is not "1.17.0-beta1"). The new title drops any text that the link
  check would read as a link and is cut to 120 characters, so a repair never costs a draft. A
  summary or action is not repaired: the guard checks them, and the
  [fact carry](../evaluation/metrics/fact-carry.md) metric measures them. A repair is logged as a
  warning.
- Runs the [link check and format check](checks.md) on every draft. If every draft is rejected,
  each writer that produced a draft gets one retry, with the problems listed and every link masked.
  There is no second retry.
- Can build a draft without any model: the fallback digest (`fallbackDigest.ts`). The digest run
  uses it when no writer draft survives the checks and the output guards. See
  [Fallback digest](#fallback-digest).
- A writer that errors, or ends with fewer than 3 items, is recorded as a failure and the next
  writer still runs. If every writer fails, the run fails at step `write`.
- Saves `drafts.json`: every draft, the writer failures and the rejections with their problems.

## Fallback digest

The fallback digest is a draft by the writer named `fallback`, made by code from the selected items.
No model writes it, so treat it as a plain list of releases, not as a written summary.

- Each item keeps its own title (cut to 120 characters) and its own URL. The summary is the first
  whole sentences of the item's collected summary that fit in 40 words, or a cut at a word ending in
  `...`. An item with no summary reads "No summary in the source."
- Links, other URLs, em dashes, pipes and character references are dropped from that text, so the
  link check and format check pass.
- Every item is "good to know" and has no action line. The headline is "Releases this week:" and up
  to three areas. It keeps at most `topN` items in rank order.
- It is rendered with the footer line "Written from the sources' own words." and run through the
  same link check and format check as a writer draft. The digest run decides when to use it. See
  [digest](digest.md#fallback-digest).

## What you can configure

- `models.writers`: replaces the profile's writer panel with your own list of unique model tags.
  One entry turns the panel off, so there is no judge. See [models](../configuration/models.md) and
  [change models or writers](../runbooks/configure/change-models-or-writers.md).
- `profile` chooses the default panel. See [profiles](../configuration/profiles.md).
- `topN` and `focusAreas`. See [collection limits](../configuration/collection-limits.md) and
  [focus areas](../configuration/focus-areas.md).
- `models.timeoutsMs.write` (default 600 s), `models.retries`, `models.think.write`, `models.seed`
  and `models.temperature.write` (default 0.2). See
  [set seed and temperature](../runbooks/configure/set-seed-and-temperature.md) and
  [change timeouts and retries](../runbooks/configure/change-timeouts-and-retries.md).
- The word limits and the one-retry rule are fixed in code. All keys:
  [config keys](../reference/config-keys.md).

## What can go wrong

- Every writer fails: the run is `failed` with step `write`, and the note reads "Every writer
  failed". The reasons are under `failures` in `drafts.json`. See
  [failed run](../runbooks/debug/failed-run.md).
- A writer is too slow or the machine runs out of memory. See
  [slow model or out of memory](../runbooks/debug/slow-model-or-out-of-memory.md).
- Every draft fails the checks even after the retry: the week is sent as the fallback digest
  (`fallback: true` in `run.json`), not `blocked`. See [blocked run](../runbooks/debug/blocked-run.md).
- The digest misses an item you expected, or names the wrong one. See
  [missing or wrong item](../runbooks/debug/missing-or-wrong-item.md).
- `pnpm digest show <week> --part drafts` shows each writer's draft and why it was rejected.

## Code and tests

- Folder: [src/write/](../../src/write/). Maintainer notes: [CLAUDE.md](../../src/write/CLAUDE.md).
- No port of its own. It calls the model port of [models](models.md) with the role `write`.
- Tests sit next to the code and script each writer's reply with a fake model provider.

## Related

- Before: [process](process.md). Inside: [checks](checks.md). After: [guards](guards.md), then
  [select](select.md).
- The layout used to render a draft is in [render](render.md).
- Writer quality is measured by [format](../evaluation/metrics/format.md) and
  [groundedness](../evaluation/metrics/groundedness.md).
