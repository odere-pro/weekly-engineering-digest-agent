# Known limits

Part of [Operations](README.md).

The honest list. Each item says what happens and why.

## Quality

- Only the `light` profile is measured. Format is at 83% on its baseline (one recorded week
  produced no digest on its first replay). See [results](../evaluation/results.md).
- The thresholds were tuned on `light` only.
- The groundedness guard can reject good drafts, in particular on the headline and intro. When
  every draft is rejected the week goes out as a fallback digest (see below), not as a failure.
- Same-release dedupe is narrow on purpose. The same story from two feeds can get through when
  one title has no version.
- The link check ignores autolinks with a scheme other than `http(s)` (`<mailto:a@b.c>`,
  `<javascript:x>`), and accepts a collected URL with extra tracking parameters or a fragment
  (unless that holds another URL or a `www.`). It reads a bare URL as a Markdown viewer does, to
  the next space, so a few harmless forms fail it and the writer retries: a URL in square
  brackets, one with `|` or `(` glued on, an `<a href="...">` tag.
- An item's link is made safe for Markdown when it is collected: brackets, quotes, `|`, `\`,
  spaces and trailing punctuation are percent-encoded. A link whose host is an IPv6 address in
  brackets (`http://[::1]/x`) is no longer a link after that, so its entry is left out.
- `digest.md` writes `<` and `>` in the model's and the feeds' text with a backslash
  (`\<svg\>`), so a viewer that allows HTML shows tags as text. A viewer that does not read
  Markdown shows the backslashes. A `digest.md` saved before this keeps its raw brackets; resuming
  such a week sends the Markdown to the missing channels without the view.
- A misreading that uses the source's own words passes every layer. In the recorded week
  2026-W36, a Kubernetes storage version migration item said "use object storage in Kubernetes"
  for a source that means stored API objects. No check compares meaning: only the judge's accuracy
  score or a person sees it.
- A version, CVE or GHSA id or date in an item title that its source lacks is replaced in code by
  the source title, but the same fact in a summary or action line is not repaired. Only the
  groundedness guard reads those, and it can miss one. A title may name a shorter version than the
  source ("1.31" for "v1.31.2"). The check reads the source title and summary only: a version that
  is only in the source URL is replaced too, and a version the summary mentions for something else
  counts as present. See [write](../features/write.md).
- The fallback digest starts only when every draft is rejected by the checks or the guards. A low
  judge score never starts it: the best passing draft is sent, however weak.

## Fallback digest, guards and calibration

- A fallback digest is the sources' own words, not a written summary: every item is "good to know",
  with no action line. It sends no failure note and exits 0, so only the footer line, `fallback` in
  `digest history` and `"fallback": true` in `run.json` tell you. There is no setting to turn it off.
- `digest preview` leaves out the fallback footer line. The sent message and `digest.md` have it.
- The rule guard `ruleInjection` is a fixed table of patterns. It flagged none of the 369 recorded
  items, but a new wording of an attack can slip past it, and a real item that quotes an attack
  string would match. In guard mode `all` it also means the input side drops an item only when
  the rule guard flags it. See
  [guards configuration](../configuration/guards.md#the-rule-guard-ruleinjection).
- The process step can apply a relevance calibration, but no config key or file feeds one in, and
  none is committed. Real runs use the classifier's relevance as it is.

## Running

- One replica. The lock is a file on local disk. Two machines sharing `dist/` over a network file
  system are not supported, and `dist/` needs hard links (not FAT, exFAT or some SMB shares).
- A run suspended for more than 5 minutes (a sleeping laptop) can lose its lock to another run.
- The abort signal (the run time limit, or a stop of `digest serve`) stops the feed fetches, the
  guards and every model call (classify, write, select) within one call, and is checked between the
  other steps. A delivery that has started finishes first.
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
