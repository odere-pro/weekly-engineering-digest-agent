# Engineering Digest Agent: System Design

Status: updated 2026-10-17. Describes the code on `main` after the run-semantics work (W2-08,
W2-11, W2-12), the wave 5 fixes (W5-00 to W5-14 and W5-16) and the wave 6 source, classifier and
eval changes merged so far (W6-01 to W6-04).

Sources: the product spec, `CLAUDE.md`, `.claude/rules/*` and the code. Where they disagree,
this document follows the code and lists the gap in section 9. Anything not built is marked
**planned** or **proposed**.

---

## 1. Purpose and scope

A local-first command-line batch job. Once a week it collects items from allowlisted RSS/Atom
feeds and GitHub repositories, filters them with guard models, classifies and ranks them, has
one or two local LLMs write a short digest, checks every draft in code and with output guards,
picks the best draft, and delivers it as a Markdown file and optionally by email or Slack. Every
model call goes to Ollama, so a run costs nothing.

It serves one reader: an engineer who follows AI and platform engineering. It is not a web
server and has no database, queue, multi-user features or cloud account. State is a folder of
JSON and Markdown files. AWS is an optional later target (section 7).

---

## 2. Business logic

The run is a fixed chain: collect → guardInput → classify → process → write (drafts, then the
code checks, with one retry) → guardOutput (the output guards) → select → deliver, then a finish
phase that saves the run record. A run can also stop between steps when its caller aborts it
(`RunOptions.signal`, checked before each step, never inside one).
`src/core/runDigest.ts` owns the chain; each step lives in `src/core/steps/`.
`src/core/runEnding.ts` ends a run (record, held files, failure note, pruning) and
`src/core/runResume.ts` finishes the delivery of a partly delivered week (2.9).

### 2.1 Collection (`steps/collect.ts`, `adapters/sources/*`)

| Rule            | Value                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| --------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Allowlist       | Only `config.sources` are fetched (default 24: 14 RSS/Atom and 10 GitHub repos, `config/defaultSources.ts`). The source list _is_ the allowlist.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| Window          | `[now - sinceDays, now]`; `sinceDays` is `--since Nd` (1-31) or `windowDays` (default 7). Relative to the run time, not the ISO week.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| Per-source cap  | `source.maxItems` or `maxItemsPerSource` (default 20, max 100), newest first. Dropping items before any model call is the biggest speed lever.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| Fetch policy    | 4 sources at a time; per source a 10 s timeout and 2 retries, exponential backoff from 500 ms. A fetcher throws `FetchError` with a `retryable` flag, and the step retries on it: a timeout, a network error, a 5xx, a 408 or a 429 yes; any other 4xx, a GitHub rate limit, a refused redirect, an oversize body, a feed that does not parse, or a bad URL no.                                                                                                                                                                                                                                                                                                                          |
| Redirects, size | A feed fetch follows a redirect only to the source's own host (apex and `www.` count as one; a GitHub source may also go to `api.github.com`). Never from https to http, to another port or to a URL with credentials, and at most 5 hops. `GITHUB_TOKEN` never leaves the source's origin. A body over 5 MiB fails the source. A source URL may not contain a username or password: the config does not load, and the fetchers refuse it too.                                                                                                                                                                                                                                           |
| Validation      | Every item is parsed with `ItemSchema`; items outside the window are dropped again (defence in depth).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| RSS/Atom        | Only entries with an http(s) link and a date. The `rel="alternate"` link wins, shown without tracking parameters and fragment; `published` wins over `updated`; a date with no zone is UTC. Summary is plain text from the fullest text the entry carries (`content:encoded`, `content`, `summary`, then `description`), with tags, `<script>` and `<style>` removed in one linear pass and entities decoded, so `Vec&lt;T&gt;` reads `Vec<T>`; cut to 600 chars. One bad entry is skipped, not the source. Entries of one feed that share a link (Google Cloud release notes) get `?entry=<entry id>` on their URL, because the item id comes from the link.                            |
| Pipeline        | Every source goes through one pipeline (`adapters/sources/pipeline.ts`): the adapter of its kind requests the response and parses it into raw entries (`rssAdapter.ts`; `githubAtomAdapter.ts` without a token, `githubRestAdapter.ts` with one), one shared step turns them into items, then the list is validated, cut to the window, sorted newest first and capped. `createRssFetcher` and `createGithubReleasesFetcher` keep their names and take an optional `logger`: the pipeline warns once per source about entries it skipped (`Skipped feed entries that could not be read`, with the source id, how many and the first error) and when no entry had a usable link and date. |
| Article pages   | An `rss` entry with no text in the feed gets the first paragraphs of its own page (the first `<article>` or `<main>` without navigation, header, footer, script and style, else `og:description` or the page description). This runs after the window and the cap: at most `maxItems` extra requests per source, 4 at a time, 4 s together out of the source's 10 s, 3 s per page, 2 MiB per page, and only for an entry whose link is on the feed's own host. A page may redirect to the feed's own host or to a host of the default source list (`config/defaultSources.ts`), https only, same port. A page that fails leaves its entry as it was. GitHub sources never fetch pages.   |
| GitHub          | Source URL must be exactly `https://github.com/<owner>/<repo>`. Without a token: the releases Atom feed (about the last 10 releases, prereleases included). With `GITHUB_TOKEN`: the REST API, drafts and prereleases skipped. Release links must stay on `github.com`.                                                                                                                                                                                                                                                                                                                                                                                                                  |
| URL normalize   | Lowercase host, no default port, no fragment, no `utm_*`/`ref`/`fbclid`/`gclid`/`mc_cid`/`mc_eid`/`source` params, sorted query, no trailing slash. Item id = first 16 hex chars of SHA-256 of the normalized URL.                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| Dedupe          | Same id: the first occurrence wins, so earlier sources in the config take precedence. Each source is cut to its cap again afterwards, newest first.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| Failed sources  | Never fail the step. Each is recorded as `{ sourceId, error }` in `run.json`, with the error text cut to 300 chars.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| Zero items      | The run ends `quiet` and sends a failure note ("no items collected", with the number of failed sources). A single source that yields no usable item logs the warning `Source returned no usable items`; the run record does not list it.                                                                                                                                                                                                                                                                                                                                                                                                                                                 |

### 2.2 Input guards (`steps/guardInput.ts`, `adapters/guard/*`)

- Config: `guards.input = { enabled, mode: "any" | "all", checks: { clefPolicy, graniteRisk } }`,
  all on by default.
- A check runs when the section is enabled, the check is on, and the composition root supplied
  a guard with that id. Otherwise it is "disabled": listed in `run.json` (`disabledGuards`) and
  named in the digest footer ("Guards off this week: ...").
- Guards run one after another over all items, one item per call, so only one guard model is
  loaded. Within a guard, `applyGuards` (`steps/guardRun.ts`) can keep up to `GUARD_CONCURRENCY`
  calls in flight at once (W5-16). The constant is 1, so calls run one at a time. Results keep
  input order. When a call fails, no new call starts, the calls in flight finish, and the error of
  the earliest failing item is thrown, so the error does not depend on timing. `guardInput` and
  `guardOutput` take an optional `concurrency` that overrides the constant (a whole number of at
  least 1). On the `light` profile, limits 1, 2 and 4 took about 112 s each for 116 calls with
  identical verdicts, and a call took about as many times longer as the limit: Ollama served the
  calls one at a time. Raise the constant only after timing a setup that runs requests in
  parallel (`OLLAMA_NUM_PARALLEL`, a remote server). A call that Ollama has queued still spends its
  per-attempt timeout while it waits.
- `any` (default): the first flag drops the item; later guards see only unflagged items. `all`:
  dropped only when every enabled guard flags it. Fewer false blocks, weaker protection.
- **clefPolicy** (role `guardPolicy`, `decide`): two yes/no questions, "instructions aimed at an
  AI system" and "harmful content". Flags when any P(yes) > `thresholds.guardFlag` (0.35). A
  missing or malformed answer is an error, never a pass.
- **graniteRisk** (role `guardRisk`, `generate`, temperature 0): one call per risk, `jailbreak`
  then `harm`, stopping at the first "yes". Unparsable output flags the item (fail closed).
- If every item is dropped, process selects nothing and the run ends `quiet`.

### 2.3 Classification (`steps/classify.ts`, `prompts/classify.ts`)

One `decide` call (role `classify`) per item, with four questions:

| Question       | Type                                                                             | Result                                |
| -------------- | -------------------------------------------------------------------------------- | ------------------------------------- |
| `relevance`    | score, 4 levels (not relevant, marginal, relevant, must read)                    | expected level 0-3, may be fractional |
| `area`         | choice over the focus areas plus `other` (max 26 options, so max 25 focus areas) | chosen area and its confidence        |
| `hype`         | yes/no                                                                           | P(mainly hype or marketing)           |
| `minorRelease` | yes/no                                                                           | P(patch release with only bug fixes)  |

A wrong answer type, or an area that is not an option, fails the step. Process applies the
thresholds later. `scores.json` holds the classifications.

The model sees an item's title, its source id and kind, and its summary, plus the focus areas.
A run also passes each source's `Source.area` as a hint (`areaHintsOf`, W6-03): a trusted line
`Source tag: <area>` between the data rule and the item's untrusted block (in the generate
fallback, a line `Source tag for <id>: <area>` before the blocks). The tag is one line, with
whitespace collapsed, and a source without an area adds nothing, so its prompt is unchanged. It
is a hint, not an answer: the model still picks the area itself from the focus areas and `other`,
and the tag need not match one of them (D15).

The same file has a **generative fallback** (`mode: 'generate'`): 10 items per
`generateStructured` call, item ids and areas as JSON Schema enums, temperature 0, one retry
batch for items the model left out, then "not relevant". `runDigest` never selects it (D5).

### 2.4 Process (`steps/process.ts`, code only)

1. **Rank**: relevance desc, areaConfidence desc, publishedAt desc, then id, source, title and
   URL as stable tie-breakers. Input order never matters.
2. **Drop**, first matching reason wins: `sent-before` (normalized URL sent in the last
   `dedupeWeeks` weeks, default 4, read from earlier `run.json` files that are `sent` or hold a
   non-empty `deliveredTo`) → `duplicate` (same id, or from another source the same normalized
   title, or the same release; the best-ranked copy stays) → `low-relevance` (< `minRelevance`, default 1.5) → `hype` (> `maxHype`, 0.6) →
   `minor-release` (> `maxMinorRelease`, 0.75).
   - **Same release** means the same product name and version token in the title (`v` stripped,
     a trailing `.0` folded), with nothing else after the version but a subtitle or an
     announcement word ("is out", "now available", "on ..."), and no other version in the title.
     It is narrow on purpose: "Claude 3.5 Sonnet" and "Claude 3.5 Haiku" stay apart. It misses a
     pair where one title has no version, so the writer prompt also asks for one entry per release.
     It does merge the same product on two platforms ("Kubernetes 1.34 now available in GKE"
     and "... in EKS"). The duplicate stage runs before the quality filters, so a best copy that
     a later filter drops takes its story with it.
3. **Spread across focus areas**: greedy by rank, but no area takes a third slot while an area
   with fewer than 2 slots still has an item. After that, the least-filled area goes first.
4. **topN**: 3-5 items (default 5). Fewer than 3 → `quiet`, without a note.

The default thresholds come from the sweep over the 60 labelled classifier cases (W3-03). They
were tuned on the `light` profile only. The run record keeps `counts.afterProcess`: the items
that passed the filters, which is `selected` plus the ones cut as `below-top-n`.

### 2.5 Writing (`steps/write.ts`, `prompts/write.ts`)

- The **writer panel** is `profile.writers` (or `config.models.writers`). Writers run one after
  another, in config order, on the same prompt: a system prompt (role, data rule, output rules,
  one worked example) plus the selected items, each in an untrusted-data block.
- Output is a **structured `Digest`** (headline, intro, 3-5 items with itemId, title, url, area,
  summary, whyItMatters) via `generateStructured()`; the step sets `weekId`.
- **Provenance**: a digest item survives only if its `itemId` is a selected item, used once; its
  URL is replaced by the source item's URL. The model can name an item but never choose its
  link, so the schema does not validate the `url` it writes (a bad one costs no repair call).
  Fewer than 3 items left fails that writer.
- A title that restates the tag after a colon ("tool v1.2.0: Release v1.2.0") is cut back to
  "tool v1.2.0".
- The prompt gives the format limits from `checks/formatCheck.ts` (3-5 items, under 500 words,
  about 400 as the target), so the two cannot drift. It also asks for one entry per release:
  two items about the same release become one entry, unless that would leave fewer than 3.
- A failed writer (timeout, invalid JSON after repair, too few items) is recorded with
  `rejectedBy: ["write"]`; the next writer still runs. When every writer fails, the run is
  `failed` at step `write` (D3).
- The step then fixes each draft in code (`prepareDraft`): cut to `topN` items, replace em
  dashes with commas (dropped at the ends of a field), and add `https://` to a link the writer
  left bare (W5-11). That link is `www.host/path` or `//host/path` in the headline, the intro or
  an item's title, area, summary or why-it-matters. It is fixed only when, with `https://` added
  and both sides normalised as the link check does, it is exactly one collected URL; the
  collected URL as written replaces it. A match starts only at the start of a field or after
  whitespace or a bracket, quote or emphasis character, so nothing inside a full `https://` URL
  changes. Up to 8 closing characters (`)]}.,;:!?*_~`) are trimmed off the end, and a token over
  2048 characters is skipped. Any other link stays as it is and the link check rejects it, so a
  draft can only gain URLs the check accepts. The step logs
  `Added https:// to links the writer left bare` with the writer and a count. The link and format
  checks follow (2.6).
- **One retry (`writeCheckedStep`).** When no draft passes the link or format check, each writer
  that has a draft gets one more call, in reverse writer order (the last model is still loaded).
  The prompt is the first prompt plus the problems the checks found, in an untrusted-data block
  (`check-problems`), format problems first, at most 5, each cut to 200 chars. The problems quote
  model text, so the prompt never shows a link. For the two link problems it keeps the check's
  words, puts `[url removed]` where the link was, and adds the kind of fault:
  `(this link has no https:// scheme or is malformed)` or
  `(this link is not one of the item urls)`. The same fault shows once. In any other problem, every `http:`, `https:`, `www.` and `//` link is masked as
  `[url removed]`. The closing instruction asks for every link in full, starting with `https://`.
  A writer is retried once per run; a writer with no draft is not retried; a failed retry
  keeps the writer's first draft and its rejection.
- `drafts.json` is `{ drafts, failures, rejections }`. `drafts` holds the prepared drafts, with a
  writer's retried draft in place of its first. `failures` lists writers with no draft; a failed
  retry has `retry: true`. `rejections` lists each draft the checks rejected: writer, `attempt`
  (1 first draft, 2 retry), `rejectedBy` and the bounded problems. The same problems go to the log
  at warn (`Draft failed the checks`). They never go to `run.json` or the failure note.

### 2.6 Per-draft checks and output guards (code checks in `steps/write.ts`, guards in `checkDrafts`)

Each draft on its own:

1. **Render** to Markdown (`render.ts`): `# headline`, `_Week 2026-W43_`, intro, then per item
   `## n. title`, summary, `**Why it matters:** ...`, `[Source](url)`, plus the guards footer.
2. **Link check** (`checks/linkCheck.ts`): every `item.url` must equal a collected URL after
   normalization, and every URL-like string in every field and in the rendered Markdown
   (Markdown destinations, `href`/`src`, bare URLs, after decoding entities and escapes) must be
   known. Scheme-less or malformed links (`www.`, `//host`, `http:` without `//`) are rejected.
   A full `http(s)://` URL that is collected is judged as a whole and left out of that search, so
   a `www.` in its host, path or query is part of the URL (W5-11). Before W5-11 the check read the
   `www.` of a valid `https://www.docker.com/...` link as a link without a scheme, which left
   2026-W39 without a digest. Still rejected: a bare `www.host`, `ftp://www.host`,
   `https:/www.host`, `https:www.host`, `//www.host`, `[x](www.host)` and `href=www.host`. An
   unknown `https://www.evil` is an "Unknown URL" problem. A numeric character reference past
   U+10FFFF (`&#x110000;`) is rejected too: it is a problem, not an error, and for the rest of
   the scan it reads as U+FFFD, so a URL hidden behind valid references is still found.
3. **Format check** (`checks/formatCheck.ts`): 3-5 items; headline, intro, summaries and
   why-it-matters present; no em dash; under 500 words (link targets do not count).
4. **Output guards**, only on drafts that passed 2 and 3, with the same `enabled`/`mode`/`checks`
   rules as input:
   - **graniteGroundedness** (role `guardRisk`): one `generate` per digest item, with the source
     item as the document and summary plus why-it-matters as the text. "yes", unparsable
     output, or a missing source item flags the draft. After the items, one more call checks the
     headline and intro against every source item the digest cites (flags `ungrounded headline
or intro`; skipped when no cited item has a source, since the missing sources already
     flag the draft). Item titles are not checked. This call uses its own criterion,
     `GRANITE_CRITERIA.headline` (W5-11), not Granite's generic one: ungrounded means a specific
     fact about a release (version, date, number or benchmark, capability, security fix, who built
     it) that no document supports; naming the week, counting the releases or saying they are
     worth a look is not a fact. The generic definition flagged the headline line of 5 of 10
     clean control drafts on `light` (item calls: none). With this criterion, a targeted check
     flagged 0 of 10 controls, still caught all 10 groundedness attack drafts (each by an item
     call) and flagged 20 of 20 drafts with a made-up intro. It is not a full eval.
   - **clefRubric** (role `guardPolicy`): one `decide` per draft (off-task, hype, harmful);
     P(yes) > 0.5 flags. The format check keeps a draft under 500 words, which is below the state
     limit of every decision model (3.3), so the whole draft is judged.

Link check and format check have no config switch. If no draft passes, the run ends `blocked`
and the failure note names each writer and the check ids that rejected it. The shared guard
engine (which guards run, and how `any` and `all` combine their verdicts) is `steps/guardRun.ts`;
both guard steps use it.

### 2.7 Judge selection (`steps/select.ts`, `prompts/judge.ts`)

- Runs only when the profile has a judge (`judge !== null`) and two or more drafts passed.
  Otherwise the first passing draft in writer order wins, with no scores.
- If the judge fails (an error, a missing or non-score answer), the first passing draft in
  writer order wins too: a warning (`judge failed, using the first draft in writer order`), no
  scores at all, and `SelectOutput.judged` is false. The week is not failed. `Winner chosen`
  logs `judged`.
- One `decide` call (role `judge`) per draft, never two drafts in one call (no position bias).
  The state holds the data rule, the rendered draft and only that draft's source items; not the
  writer name.
- Four score questions with 5 levels: `accuracy`, `clarity`, `whyItMatters`, `focusFit`.
  Rating = level index + 1 (clamped to 1-5); overall = mean of the four.
- Highest overall wins; within 1e-9 is a tie, won by the writer listed first in config. Scores
  go on the drafts in `run.json`; the winner's Markdown is `digest.md`.

### 2.8 Delivery (`adapters/delivery/*`)

| Channel  | When                                                | Digest                                                                                                                | Failure note                                  |
| -------- | --------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- | --------------------------------------------- |
| markdown | always                                              | `<delivery.markdown.dir>/<week>.md` (default `data/digests`), atomic write                                            | `<week>.failed.md`                            |
| email    | `delivery.email` set; needs `SMTP_PASSWORD`         | subject `Engineering digest <week>: <headline>` (max 120 chars), Markdown as plain text; STARTTLS required by default | title "Weekly digest <week> failed at <step>" |
| slack    | `delivery.slack.enabled`; needs `SLACK_WEBHOOK_URL` | Markdown converted to mrkdwn; `&`, `<`, `>` escaped so feed text cannot produce `<!channel>`; redirects are errors    | one line, max 300 chars                       |

- Recipients, the webhook and the file path come from config and `.env` only. A configured
  channel without its secret makes `buildApp` fail with an error naming the variable.
- `SLACK_WEBHOOK_URL` must be an `https:` URL. The config refuses `http:`, and the Slack adapter
  refuses it at send time, with an error that never carries the URL (its path is the secret).
- `deliver` tries every channel and records the ones that took the digest in
  `RunRecord.deliveredTo`. If any failed, the step fails and the error names the channels that
  did get the digest. `sentUrls` is recorded as soon as one channel has the digest.
- The container wraps every channel (`app/retryingDelivery.ts`, `app/redacting.ts`). A send is
  tried again twice, after 5 s and 10 s, for `sendDigest` and `sendFailure` alike, but only when
  the error shows that nothing was sent (W5-12):
  - a failure while connecting: `ECONNREFUSED`, `ENOTFOUND`, `EAI_AGAIN`, `EHOSTUNREACH`,
    `ENETUNREACH`, nodemailer's `EDNS`, `UND_ERR_CONNECT_TIMEOUT`, or a nodemailer connect,
    greeting or upgrade timeout;
  - an HTTP 429 or 5xx answer (Slack);
  - an SMTP 421, 450 or 451 reply.

  Everything else is final: a reset or a socket timeout after the body went out, the 15 s timeout
  of a whole Slack request (it cannot be told from a timeout after the body went out), any other
  4xx, an SMTP 5yz reply, and SMTP 452 and 454. The subject, Markdown and failure message have
  the known secrets taken out before every send.

- **Typed delivery errors.** The retry decision reads facts, never the message. The adapters
  throw a `DeliveryError` (`adapters/delivery/deliveryError.ts`) with `code`, `originalCode` (the
  system code nodemailer replaced, `ESOCKET` over `ECONNREFUSED`), `status` (HTTP), `responseCode`
  (SMTP) and `timeoutType`. Slack throws one with `status` for a non-2xx answer. `redactedError`
  (`delivery/redact.ts`) rebuilds a failed network call as a `DeliveryError` that keeps those
  facts, a copy of the cause chain (5 levels) with every message and name redacted, and never the
  original errors. `fetch` puts its code on the cause, so `deliveryFacts` reads the chain and each
  fact comes from the outermost error that states it. An `AggregateError` (a host that refuses
  both its IPv4 and IPv6 address) gets a message made of its inner messages, each once. The text
  names the code when it hides it (`fetch failed (ECONNREFUSED)`).
- **At-least-once remains.** A message can still go out twice: when the server took it and then
  answered 429, 5xx, or an SMTP 421, 450 or 451 (a proxy 502 after Slack accepted the post); or
  when a channel fails in a way that is not retried (a reset, a socket or request timeout), the
  failed delivery fails the run, and the run's resume (2.9) sends to that channel again. The
  delivery layer no longer retries a channel that may already have the message, so the retries do
  not multiply with the scheduler's.
- A failure note goes to every channel after `failed`, `blocked` or a zero-item `quiet` run,
  never in a dry run. Best effort, secrets redacted.
- **One note per failed week** (W5-12). `RunOptions.notifyFailure` (default true) says whether a
  failed run sends its note. When false, the run still saves `run.json` and `error.json` but
  holds the note back and logs `Failure note held back: notifyFailure is off for this run`.
  `digest serve` passes false on every attempt the scheduler will retry, and true on the last
  attempt. The run sends its note anyway when no retry can follow: its failure starts with
  `Run aborted` (it was told to stop) or names `--force`, it did not fail (blocked and quiet
  notes), or its record could not be saved. The decision goes by the recorded error, not by the
  run's signal, so the scheduler, which reads the same record, decides exactly as the run did.
  If the retry the note waited for never runs, `SchedulerOptions.onGiveUp` is called once with the
  last failed result and `sendHeldNote` (`runEnding.ts`) sends the note it would have sent, to
  every channel, best effort. The log line is
  `Sending the failure note held back for a retry that will not run`. That happens when `stop()`
  cancels the retry or came during the failing attempt, when the lock stays held until the lock
  retries run out, when the retry throws instead of running, and when the failed run also hit the
  time limit. It does not happen when the note is
  already out: a retry that ended with an abort or a `--force` failure (the run sent it), a retry
  that could not save its record (`RecordNotSavedError`: the run sent a "could not save" note), a
  recovered week, or a last attempt. Without an `onGiveUp` the scheduler holds nothing back. After
  `stop()` the next start runs the failed week again, and that run sends its own note: the note of
  a new failure, not a second one for the old.

### 2.9 Idempotency, locking and retention

- **Run id** = ISO week of the run start in `schedule.timeZone` (e.g. `2026-W43`). Evals and the
  scheduler can pass a week explicitly.
- **Idempotency**: a week whose `run.json` has status `sent` is `skipped` (exit 0, nothing saved)
  unless `--force`. Checked before the lock and again under it.
- **`--force`**: runs the whole week again and delivers to every channel. A run never replaces a
  record that got further with delivery: a `sent` record is replaced only by a `sent` run, and a
  partly delivered record only by a run that reached a channel. When the earlier record stays,
  so do the week's files. Such a run (a week that reached a channel earlier) holds its
  `items.json`, `scores.json`, `drafts.json` and `digest.md` in memory and writes them, and
  `error.json`, only if its own record is saved. `RunResult.markdown` is set only when
  `digest.md` was written, so `digest run` never names a file this run did not write. In that
  case `RunResult.kept` holds the reason: "Kept the sent run record; this forced run did not end
  sent" for a sent week, "Kept the partly delivered run record; this run delivered nothing" for a
  partly delivered one. It is logged at warn, and `digest run` prints it as its last line,
  `<reason>. The week's run folder is unchanged.`, where the Digest line would be. A resume never
  keeps, because its record always reached a channel.
- **`--dry-run`**: no deliver step and no failure note; `digest.md` and `run.json` (status
  `dry-run`) are still written, unless the week already reached a channel (see `--force`).
- **Partial delivery and resume.** A run that fails in `deliver` after some channels took the
  digest is `failed` with a non-empty `deliveredTo`. A later run of that week that is not
  forced and not a dry run does not start over. It skips the health check and every model step
  and sends the saved `digest.md` to the configured channels not in `deliveredTo`. On success
  it writes `sent` with `deliveredTo` covering every channel, the old counts, drafts and winner,
  and the resumed `deliver` timing added; its `startedAt` and `finishedAt` cover the resume.
  Before it sends, it checks (`verifyDigest`) that the `[Source](url)` links in `digest.md` are
  exactly `sentUrls`. If `digest.md` is gone or differs, the run fails at `deliver`, sends
  nothing and says to use `--force`. The check is skipped when no configured channel is missing
  (the remaining channels were removed from config), and the week is then sealed `sent`. A
  refused resume returns no digest path.
- **Run lock**: `<dataDir>/digest.lock` holds `{ pid, runId, startedAt }` plus `hostname`, a
  per-process `token`, `pidNamespace` (Linux) and `heartbeatAt`. It is created atomically (temp
  file + hard link), and the holder rewrites `heartbeatAt` every 60 s. A live, recent lock fails
  the run with exit 1 and no record. A lock is taken over when its pid is gone (checked only
  where the pid means something: the same host and PID namespace), when the pid was reused by
  another process, when its heartbeat is 5 min old, when a lock without a heartbeat is 6 h old,
  or when the file is unreadable. The takeover happens under a 30 s takeover-guard file so two
  contenders cannot both take it. Each acquire first removes orphaned
  `digest.lock.<pid>.<uuid>.tmp` and `digest.lock.takeover.<pid>.<uuid>.tmp` files older than
  10 min (names match exactly; best effort, logged).
- **Retention**: after every finished run, week folders older than the current week plus
  `keepWeeks` (default 12) lose everything except `digest.md`. Prune errors are only logged.

### 2.10 Run statuses and exit codes (`core/schemas.ts`)

| Status    | When                                                                                                 | Exit | `run.json`             | Failure note        |
| --------- | ---------------------------------------------------------------------------------------------------- | ---- | ---------------------- | ------------------- |
| `sent`    | winner delivered on every channel                                                                    | 0    | yes                    | no                  |
| `dry-run` | `--dry-run` and a winner was picked                                                                  | 0    | yes                    | no                  |
| `skipped` | week already sent, no `--force`                                                                      | 0    | no                     | no                  |
| `quiet`   | no items collected, or fewer than 3 selected                                                         | 3    | yes                    | only for zero items |
| `blocked` | drafts exist and every one was rejected by the checks or the guards                                  | 2    | yes                    | yes                 |
| `failed`  | health check, a step error (also every writer failing), a delivery error on any channel, or an abort | 1    | yes, plus `error.json` | yes                 |

Also exit 1, outside the table: a held lock, an invalid config or `.env`, or a failure to save
`run.json` (alerted first).

A run whose caller aborts it (`RunOptions.signal`) ends `failed` with `Run aborted before the
<step> step: <reason>` and releases the lock. The signal is checked before each step, never
inside one, so the running step finishes first. `digest serve` sets it in two cases: the run
time limit of 3 h (reason `run timed out after 3 h`) and a second stop signal (8.2). `digest run`
sets none.

#### Run flow with decision points

```mermaid
flowchart TD
  START(["digest run, scheduler tick or catch-up"]) --> Q_SENT{"Week already sent?"}
  Q_SENT -->|"yes, not forced"| S_SKIP["skipped: exit 0, nothing saved"]
  Q_SENT -->|"no, or forced"| Q_LOCK{"Run lock free?"}
  Q_LOCK -->|"no"| E_LOCK["error: another run in progress, exit 1, no record"]
  Q_LOCK -->|"yes"| Q_SENT2{"Sent meanwhile? (checked again under the lock)"}
  Q_SENT2 -->|"yes, not forced"| S_SKIP
  Q_SENT2 -->|"no"| Q_PART{"Failed week that some channels already got? (not forced, not a dry run)"}
  Q_PART -->|"yes"| Q_RES{"digest.md found, links match what was sent?"}
  Q_RES -->|"no"| S_FAIL["failed + note: exit 1"]
  Q_RES -->|"yes"| DELIVER["deliver on the channels that lack it, every channel when new"]
  Q_PART -->|"no"| Q_HEALTH{"Ollama up and every model this run uses pulled?"}
  Q_HEALTH -->|"no"| S_FAIL
  Q_HEALTH -->|"yes"| COLLECT["collect, save items.json"]
  COLLECT --> Q_ITEMS{"Any items?"}
  Q_ITEMS -->|"no"| S_QUIET_N["quiet + note: exit 3"]
  Q_ITEMS -->|"yes"| GIN["guardInput: drop flagged items"]
  GIN --> CLS["classify, save scores.json"]
  CLS --> PROC["process: dedupe, thresholds, rank, area spread, topN"]
  PROC --> Q_MIN{"3 or more items selected?"}
  Q_MIN -->|"no"| S_QUIET["quiet: exit 3"]
  Q_MIN -->|"yes"| WRITE["write: each writer drafts, then link check and format check, save drafts.json"]
  WRITE --> Q_DRAFT{"Any draft?"}
  Q_DRAFT -->|"no: every writer failed"| S_FAIL
  Q_DRAFT -->|"yes"| Q_CODE{"Any draft passed the code checks?"}
  Q_CODE -->|"no"| RETRY["retry each writer once with the problems found"]
  Q_CODE -->|"yes"| GUARDS["output guards on the drafts that passed"]
  RETRY --> GUARDS
  GUARDS --> Q_PASS{"Any draft passed?"}
  Q_PASS -->|"no"| S_BLOCK["blocked + note: exit 2"]
  Q_PASS -->|"yes"| SELECT["select: judge if 2 or more drafts, save digest.md"]
  SELECT --> Q_DRY{"Dry run?"}
  Q_DRY -->|"yes"| S_DRY["dry-run: exit 0"]
  Q_DRY -->|"no"| DELIVER
  DELIVER --> Q_DEL{"All channels OK?"}
  Q_DEL -->|"yes"| S_SENT["sent: exit 0"]
  Q_DEL -->|"no"| S_FAIL
  ANY["any step throws, or the run is aborted between steps"] -.-> S_FAIL
  S_SENT --> FIN["finish: run.json, error.json if failed, note, prune, release lock"]
  S_DRY --> FIN
  S_QUIET --> FIN
  S_QUIET_N --> FIN
  S_BLOCK --> FIN
  S_FAIL --> FIN
```

Diamonds are decisions in `runDigest` (the resume branch is in `runResume.ts`); rectangles with a
status are where the chain stops. Every status except `skipped` (and the lock error) goes
through the same finish phase, so every real run leaves a `run.json`, unless an earlier record
of the week got further (2.9). The dotted edge: any step error becomes `failed`.

#### RunStatus as the state of one week

```mermaid
stateDiagram-v2
  state "no run.json" as NONE
  state "running (lock held)" as RUNNING
  state "sent" as SENT
  state "dry-run" as DRY
  state "quiet" as QUIET
  state "blocked" as BLOCKED
  state "failed" as FAILED
  state "skipped (nothing stored)" as SKIPPED
  [*] --> NONE
  NONE --> RUNNING : run or tick
  RUNNING --> SENT : every channel delivered
  RUNNING --> DRY : dry run picked a winner
  RUNNING --> QUIET : no items or fewer than 3
  RUNNING --> BLOCKED : every draft rejected
  RUNNING --> FAILED : health, step or delivery error
  DRY --> RUNNING : next run or catch-up
  QUIET --> RUNNING : next manual run
  BLOCKED --> RUNNING : next manual run
  FAILED --> RUNNING : next run or catch-up
  FAILED --> SENT : rerun delivers the missing channels
  SENT --> SKIPPED : run without force
  SKIPPED --> SENT : record unchanged
  SENT --> RUNNING : run with force
  note right of SENT
    A forced run that ends in any other
    status keeps this sent run.json.
  end note
```

This is the status in `data/runs/<week>/run.json` across runs of the same week. Every status
except `sent` can run again without `--force`. The scheduler's catch-up on start (section 8.2)
runs a week with no record or a `failed` or `dry-run` one, and leaves `sent`, `quiet` and
`blocked` weeks alone; a manual `digest run` skips only `sent`. Only `sent` is terminal for
normal runs; `skipped` is never written.

---

## 3. How it works as an agentic app

### 3.1 Which steps use a model

| Step                             | Kind                                  | Role(s)                    | Port call                   |
| -------------------------------- | ------------------------------------- | -------------------------- | --------------------------- |
| collect                          | deterministic code                    | -                          | `SourceFetcher.fetch`       |
| guardInput                       | LLM: decision model + chat guard      | `guardPolicy`, `guardRisk` | `decide`, `generate`        |
| classify                         | LLM: decision model                   | `classify`                 | `decide`                    |
| process                          | deterministic code                    | -                          | -                           |
| write                            | LLM: generative, structured           | `write`                    | `generate` with JSON Schema |
| render, link check, format check | deterministic code                    | -                          | -                           |
| guardOutput                      | LLM: chat guard + decision model      | `guardRisk`, `guardPolicy` | `generate`, `decide`        |
| select                           | LLM decision (judge) + code tie-break | `judge`                    | `decide`                    |
| deliver, finish                  | deterministic code                    | -                          | `Delivery`, `RunStore`      |

The input bounds the model calls. With N collected items, K items after the input guards, W
writers and P drafts past the code checks: up to N clefPolicy, up to 2N granite, K classify, W
to 2W writer (one repair each), up to 6P groundedness (one per item and one for the headline and
intro), P rubric and P judge calls, plus retries. A week where no draft passes the link and
format checks adds one more writer call per writer that has a draft.

### 3.2 Roles and profiles (`config/profiles.ts`)

Code asks for a role, never a model tag; the one exception is the write step, which passes each
writer tag from the profile as an opaque id. A profile maps roles to Ollama tags.

| Role                 | quality (default)                                  | fast                             | light                         | non-Mac fallback         |
| -------------------- | -------------------------------------------------- | -------------------------------- | ----------------------------- | ------------------------ |
| classify             | `clef:latest`                                      | `strands-decider:2b-mlx-bf16`    | `strands-decider:2b-mlx-bf16` | `clef:latest`            |
| guardPolicy          | `clef:latest`                                      | `strands-decider:2b-mlx-bf16`    | `strands-decider:2b-mlx-bf16` | `clef:latest`            |
| guardRisk            | `granite4.1-guardian:8b`                           | `granite4.1-guardian:8b`         | `granite4.1-guardian:8b`      | `granite4.1-guardian:8b` |
| write                | `gemma4:31b-mlx`, `nemotron-3.5-lightning:30b-mlx` | `nemotron-3.5-lightning:30b-mlx` | `gemma4:e4b-mlx`              | `gemma4:31b`             |
| judge                | `clef:latest`                                      | none                             | none                          | none                     |
| needs Apple silicon  | yes                                                | yes                              | yes                           | no                       |
| min Ollama (in code) | 0.35.1                                             | 0.40.0                           | 0.40.0                        | 0.35.1                   |

- `resolveProfile()` swaps every profile that needs Apple silicon for the non-Mac fallback when
  the process is not on `darwin/arm64`. All three named profiles need it. `loadConfig` keeps the
  host it resolved for in `LoadedConfig.platform` (read with `platformOf`), so `doctor` and
  `eval` judge the same host.
- `light` has no separate non-Mac fallback (D2): off a Mac it becomes `clef:latest` and
  `gemma4:31b`, which need far more than 16 GB. `digest doctor` warns about it, and
  `digest init` says so when you pick `light`.
- `modelsInUse(profile, guards)` is `requiredModels` without the model of a guard role
  (`guardPolicy` or `guardRisk`) whose checks are all off; a tag another role still uses stays.
  The health check at the start of a run and `digest doctor` use it (D4). Model pulls still use
  `requiredModels`.
- `models.writers` in config replaces the panel. With 2+ writers the judge is the profile's
  judge, or `clef` if the profile has none. One writer turns the judge off.
- The judge (clef, Qwen-based) is from a different family than both default writers.

```mermaid
flowchart LR
  subgraph ROLES["Roles the code asks for"]
    R_CLS["classify"]
    R_POL["guardPolicy"]
    R_RISK["guardRisk"]
    R_WRITE["write"]
    R_JUDGE["judge"]
  end
  subgraph TAGS["Ollama model tags"]
    M_CLEF["clef:latest"]
    M_STRANDS["strands-decider:2b-mlx-bf16"]
    M_GRANITE["granite4.1-guardian:8b"]
    M_GEMMA_MLX["gemma4:31b-mlx"]
    M_NEMO["nemotron-3.5-lightning:30b-mlx"]
    M_E4B["gemma4:e4b-mlx"]
    M_GEMMA["gemma4:31b"]
    M_NONE["no judge, select skipped"]
  end
  R_CLS -->|"quality, fallback"| M_CLEF
  R_CLS -->|"fast, light"| M_STRANDS
  R_POL -->|"quality, fallback"| M_CLEF
  R_POL -->|"fast, light"| M_STRANDS
  R_RISK -->|"all profiles"| M_GRANITE
  R_WRITE -->|"quality"| M_GEMMA_MLX
  R_WRITE -->|"quality, fast"| M_NEMO
  R_WRITE -->|"light"| M_E4B
  R_WRITE -->|"fallback"| M_GEMMA
  R_JUDGE -->|"quality"| M_CLEF
  R_JUDGE -->|"fast, light, fallback"| M_NONE
```

Each edge names the profiles that use that mapping. `clef` serves three roles in `quality`,
which is why the steps keep one model loaded at a time. Every `-mlx` tag, and `strands-decider`,
needs Apple silicon.

### 3.3 `decide()` versus `generate()` (`ports/ModelProvider.ts`, `adapters/models/*`)

|                 | `decide()`                                                                                               | `generate()`                                                       |
| --------------- | -------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------ |
| Used by         | classify, clefPolicy, clefRubric, judge                                                                  | writers, both granite guards, classify fallback                    |
| Ollama endpoint | `POST /v1/systemone`                                                                                     | `POST /api/chat`, streamed NDJSON                                  |
| Input           | `state` text + 1-64 typed questions: yes/no (sent as `noul`), choice (2-26 options), score (2-10 levels) | system + user prompt, optional JSON Schema (`format`), temperature |
| Output          | per question: P(yes); chosen option with probabilities; expected level with probabilities                | text, token usage                                                  |
| Why             | no JSON to parse, short and fast, a probability to set thresholds on                                     | free text the writers need                                         |

Both calls resolve the model from the role, apply a per-role timeout per attempt (classify and
guardPolicy 60 s, guardRisk and judge 120 s, write 600 s; overridable), retry twice with backoff
(1 s, doubling, max 10 s) only on network errors, timeouts, stream errors and 5xx, and log one
line per call (role, model, latency, attempts, tokens, and the `runId` and `step` of the call,
8.3).

`decide` trims `state` to fit the model: the model's budget (10,000 chars for `strands-decider`,
which has a 4K context; 48,000 otherwise) less the size of the serialized questions, never below
1,000, keeping the head and a short tail. The warning `decide state trimmed` logs
`questionChars`. `generate` streams, so Node's fetch does not drop a writer reply whose headers
take over 300 s. A reply that stops at the token limit (`done_reason: length`) is returned as it
is, with a warning; with a JSON schema it is an unfinished document, which fails validation
and goes to the one repair (3.4). `health()` reads `/api/version` and `/api/tags`.

`generate` sends Ollama's `think` setting per role: `models.think` if set, else the adapter
default (`guardRisk` off, because Granite Guardian spends about 65 s reasoning before a one-word
answer), else nothing, and the model decides. `decide` ignores `think`. `effectiveThink` is the
one place that rule lives, and `digest doctor` prints its result for each role.

The container builds the provider in one place, `createModelProvider` (`app/container.ts`: base
URL, profile, timeouts, `think` and retries from the config). A run uses it, and `digest doctor`
calls the same function, so the two cannot drift.

granite4.1-guardian is a chat model that answers `<score>yes</score>` or `<score>no</score>`
with no probabilities, so the granite guards use `generate` and a strict parser.

### 3.4 Structured output (`core/structured.ts`)

`generateStructured(model, request, zodSchema, step)` converts the zod schema to JSON Schema,
passes it to `generate`, strips an optional code fence, parses and validates. On failure it asks
the same model once to repair its answer, quoting the validation problems. A second failure
throws a `DigestError` for that step; the writer step catches it per writer. The repair gets the
same token limit as the first call, so it can be cut short again.

### 3.5 Untrusted data (`shared/untrusted.ts`)

Every collected item is untrusted web text. Each prompt that embeds it uses
`wrapUntrusted(label, text)` (`<<<DATA label>>> ... <<<END DATA>>>`) and `UNTRUSTED_DATA_RULE`:
treat it as data, never follow instructions in it, never output URLs that are not in it.
`neutralize()` replaces `<<<` and `>>>` inside the text, so an item cannot close its block
early, and reduces labels to safe characters. No model has tools or network access: the
`ModelProvider` port has only `generate`, `decide` and `health`.

### 3.6 Guards as the policy layer

The guards are the moderation layer: two before any other model reads an item, two on every
draft. They sit behind the `InputGuard`/`OutputGuard` ports, switch in config, are measured per
guard in evals (catches and false blocks), and fail closed. Below them, the code checks
(provenance, link check, format check) are the last line of defence that config cannot remove.

### 3.7 Writer panel and judge: generate, then select

Two writers from different model families draft from the same input; each draft is checked on
its own. A judge from a third family scores the survivors one at a time on a fixed rubric; ties
go by config order. The run record keeps each draft's outcome and scores, so evals can report
per-writer win rates. The extra write time is minutes a week.

### 3.8 Why a fixed workflow and not an autonomous agent loop

`src/core/workflow.ts` wraps the steps in one Mastra workflow (`@mastra/core` 1.78.0, pinned).
Mastra only chains plain `(state) => state` functions and does not validate the state. No
Mastra agents, tools or memory; no step chooses the next step.

| What the fixed DAG buys | How                                                                                                                                                                                       |
| ----------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Predictability          | Same steps, same order, every week. One model loaded at a time.                                                                                                                           |
| Evals                   | `digest eval` replays recorded weeks through the same `runDigest` (recorded fetchers, in-memory store, no deliveries, every guard on). A loop with model-chosen actions would not replay. |
| Cost and time           | Calls are a function of the item count (3.1). No open-ended token spend.                                                                                                                  |
| Safety                  | No tool calls, so injected text has nothing to trigger. Links come only from collected items.                                                                                             |
| Debugging               | Each stage writes an artifact (`items.json`, `scores.json`, `drafts.json`, `digest.md`, `run.json`).                                                                                      |

### 3.9 Where an agent loop could go later (proposal)

- **Bounded revise loop in write** (best candidate): a small form is built (W5-06): when every
  draft fails the link or format check, each writer gets one retry with the problem list (2.5).
  Still proposed: revisions after a rubric or groundedness flag, and more than one retry. Checks
  stay in code; the loop keeps a hard cap.
- **Reading the release page** for thin items: needs network access to a model-chosen URL,
  which breaks the "no tools, allowlisted hosts only" rule. Not recommended.
- **Follow-up questions or chat**: out of scope in the spec.

#### One run, end to end

```mermaid
sequenceDiagram
  autonumber
  participant EP as CLI run or scheduler
  participant APP as buildApp (container.ts)
  participant RD as runDigest
  participant ST as Steps (core/steps)
  participant GD as Guards
  participant MP as ModelProvider (Ollama)
  participant RS as RunStore (files)
  participant DL as Delivery
  EP->>APP: loadConfig, then buildApp
  APP-->>EP: DigestDeps with adapters, logger, tracer
  EP->>RD: runDigest(deps, options)
  RD->>RS: hasSentDigest(week)
  RD->>RS: acquireLock(week), then getRunRecord again
  Note over RD,DL: a partly delivered week skips to the deliver step (2.9)
  RD->>MP: health()
  RD->>ST: collect via SourceFetcher per source
  RD->>RS: saveArtifact items.json
  RD->>ST: guardInput
  ST->>GD: checkItem, guard by guard
  GD->>MP: decide (guardPolicy) or generate (guardRisk)
  RD->>ST: classify
  ST->>MP: decide (classify), one call per item
  RD->>RS: saveArtifact scores.json, read sentUrls
  RD->>ST: process (code only)
  RD->>ST: write
  loop each writer in config order
    ST->>MP: generate (write) with JSON Schema, one repair
  end
  ST->>ST: prepare, render, link check, format check (code)
  opt no draft passed the code checks
    loop each writer that has a draft, last writer first
      ST->>MP: generate (write) with the problems found, one repair
    end
    ST->>ST: check the retried drafts again
  end
  RD->>RS: saveArtifact drafts.json
  RD->>ST: guardOutput
  ST->>GD: checkDraft per draft
  GD->>MP: generate (guardRisk) or decide (guardPolicy)
  opt 2 or more drafts passed and the profile has a judge
    ST->>MP: decide (judge), one call per draft
  end
  RD->>RS: saveArtifact digest.md
  opt not a dry run
    RD->>DL: sendDigest on every channel
  end
  RD->>RS: saveRunRecord run.json
  opt failed, blocked or zero-item quiet, not a dry run, note not held back (2.8)
    RD->>DL: sendFailure on every channel
  end
  RD->>RS: prune, then release the lock
  RD-->>EP: RunResult with record and exit code
  EP->>APP: close() flushes traces
```

Time flows down. The core (`runDigest` and the steps) talks only to ports; the guards call the
same `ModelProvider` as the steps. The health check runs after the lock and before collection,
so a run with Ollama down fails in seconds.

---

## 4. Architecture

### 4.1 Style: hexagonal, as a modular monolith

One Node process, one deployable, one bundle (`dist/cli.js`). Inside: a core that knows no
vendor, file or cloud; five ports; adapters behind them. Dependencies point inward:

`cli / scheduler / evals → app/container → adapters → ports ← core`

ESLint (`no-restricted-imports`) fails the build if `src/core` or `src/ports` import adapters,
CLI, scheduler, observability, `config/load`, `node:fs`, `ollama` or `nodemailer`. Only
`src/app/container.ts` turns config into adapters, and wraps them with the decorators next to
it in `src/app/`: `retryingDelivery.ts`, `redacting.ts` (delivery and store) and `tracedModel.ts`
(the model provider). The container also gives the model provider and both fetchers a logger that
finds the run in flight on every line (8.3). Steps are plain async functions with
interface deps (ports, `Logger`, `Tracer`, `Clock`), so tests use `test/fakes` and evals swap in
recorded fetchers without touching the core.

### 4.2 Context

```mermaid
flowchart LR
  USER(["Maintainer, the single user"])
  AGENT["Engineering Digest Agent, one Node process"]
  FEEDS["Allowlisted RSS/Atom feeds"]
  GH["GitHub: releases.atom or api.github.com"]
  OLL["Ollama HTTP API"]
  SMTP["User's own SMTP server"]
  SLACK["Slack incoming webhook"]
  FS[("Local files: config, .env, data/")]
  OTEL["OTLP collector such as Jaeger (optional)"]
  USER -->|"CLI commands"| AGENT
  AGENT -->|"HTTP GET"| FEEDS
  AGENT -->|"HTTP GET"| GH
  AGENT -->|"/api/chat and /v1/systemone"| OLL
  AGENT -->|"digest, failure note"| SMTP
  AGENT -->|"digest, failure note"| SLACK
  AGENT <-->|"read config, write runs"| FS
  AGENT -.->|"spans"| OTEL
  SMTP -->|"email"| USER
  SLACK -->|"message"| USER
  FS -->|"data/digests/week.md"| USER
```

The agent is the only box we build. Every arrow out of it is outbound HTTP or SMTP the agent
starts; only the user and the scheduler call the agent. Ollama may be on the same host, on the
Mac host from inside Docker, or a Compose service (section 6).

### 4.3 Components

```mermaid
flowchart TB
  subgraph ENTRY["Entry points"]
    CLI["cli/program.ts: init, doctor, run, eval, history, serve"]
    SCHED["scheduler/scheduler.ts, started by serve"]
    EVAL["evals/runEval.ts, run by digest eval"]
    LAMBDA["handlers/lambda.ts (planned)"]
  end
  subgraph ROOT["Composition root"]
    LOAD["config/load.ts: config file + .env, zod"]
    APP["app/container.ts: buildApp"]
  end
  subgraph CORE["Core: src/core"]
    RUN["runDigest.ts, runEnding.ts, runResume.ts"]
    WF["workflow.ts (Mastra wrapper)"]
    STEPS["steps: collect, guardInput, classify, process, write, guardOutput, select, guardRun (shared engine)"]
    CHK["checks: linkCheck, formatCheck, plus render.ts"]
    STRUCT["structured.ts and prompts"]
  end
  subgraph PORTS["Ports: src/ports"]
    P_MODEL["ModelProvider"]
    P_GUARD["InputGuard, OutputGuard"]
    P_SRC["SourceFetcher"]
    P_DEL["Delivery"]
    P_STORE["RunStore"]
  end
  subgraph ADAPTERS["Adapters: src/adapters"]
    A_OLL["models/ollama.ts"]
    A_GUARD["guard/clefPolicy.ts, guard/granite.ts"]
    A_SRC["sources: pipeline, rssAdapter, githubAtomAdapter, githubRestAdapter, enrich"]
    A_DEL["delivery: markdownFile, smtp, slack"]
    A_STORE["store/fsRunStore.ts"]
  end
  OBS["observability: pino logger, OTel tracer"]
  CLI --> LOAD
  CLI --> APP
  SCHED --> APP
  EVAL --> APP
  LAMBDA -.-> APP
  APP --> A_OLL
  APP --> A_GUARD
  APP --> A_SRC
  APP --> A_DEL
  APP --> A_STORE
  APP --> OBS
  CLI -->|"DigestDeps"| RUN
  SCHED -->|"DigestDeps"| RUN
  EVAL -->|"DigestDeps, recorded fetchers"| RUN
  RUN --> WF
  WF --> STEPS
  RUN --> CHK
  STEPS --> STRUCT
  STEPS --> P_MODEL
  STEPS --> P_GUARD
  STEPS --> P_SRC
  RUN --> P_DEL
  RUN --> P_STORE
  A_OLL -.->|"implements"| P_MODEL
  A_GUARD -.->|"implements"| P_GUARD
  A_GUARD -->|"calls"| P_MODEL
  A_SRC -.->|"implements"| P_SRC
  A_DEL -.->|"implements"| P_DEL
  A_STORE -.->|"implements"| P_STORE
```

Solid arrows are calls or construction; dotted arrows are "implements". The core never points
at an adapter. The guard adapters both implement a port and call `ModelProvider`, so one Ollama
adapter serves every role.

### 4.4 Components in classical system-design terms

| Component                                      | Classical term                           | Notes                                                                                                           |
| ---------------------------------------------- | ---------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| `runDigest` as a whole                         | Batch ETL job with LLM transforms        | Extract: collect. Transform: guards, classify, process, write, checks, select. Load: deliver and run store.     |
| The chain in `runDigest` + `workflow.ts`       | Pipes and filters                        | Each stage takes the state and returns a new state; a settled state skips the rest.                             |
| `app/container.ts`                             | DI container / composition root          | Hand-written, no DI framework.                                                                                  |
| `config/load.ts`, `.env`, `digest.config.json` | 12-factor config                         | Secrets and endpoints from the environment (process env wins over `.env`); the rest in one validated JSON file. |
| ISO week `runId` + `hasSentDigest`             | Idempotency key                          | One sent digest per week; `--force` overrides.                                                                  |
| `store/runLock.ts`                             | Mutex / file lock                        | Advisory lock file with a heartbeat; stale by pid, process token, heartbeat age or file age (2.9).              |
| `adapters/models/ollama.ts`                    | Inference client                         | Timeouts, retries with backoff, error mapping, usage logging.                                                   |
| Guards + link and format checks                | Policy / moderation layer                | Switchable guards on models; checks in code that cannot be switched off.                                        |
| `steps/collect.ts` + fetchers                  | Ingestion                                | Allowlisted pull, bounded and deduplicated.                                                                     |
| `adapters/delivery/*`                          | Outbound notification                    | Fan-out to channels, plus failure alerts.                                                                       |
| `fsRunStore` (`run.json` + artifacts)          | State / audit store                      | Run history, debugging record, raw material for eval cases.                                                     |
| `evals/runEval.ts` + `digest eval`             | Offline eval harness as the quality gate | Four hard gates fail the command; the rest are reported.                                                        |
| `scheduler/scheduler.ts`                       | In-process cron job scheduler            | With missed-run catch-up and overlap protection.                                                                |
| `core/structured.ts`                           | Output validation with repair            | Schema-validated LLM output, one retry.                                                                         |

### 4.5 Ports

| Port                                      | Methods                                                                                                                          | Local adapter(s)                                                                                              | Test fake (`test/fakes`)                               |
| ----------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------ |
| `ModelProvider`                           | `generate(req)`, `decide(req)`, `health()`                                                                                       | `createOllamaProvider` (`ollama.ts`, `ollamaHttp.ts`, `systemone.ts`)                                         | `FakeModelProvider`                                    |
| `InputGuard` / `OutputGuard` (`Guard.ts`) | `id`, `checkItem(item)` / `checkDraft(draft, sources)`                                                                           | `createClefPolicyGuard`, `createGraniteRiskGuard` / `createGraniteGroundednessGuard`, `createClefRubricGuard` | `FakeInputGuard`, `FakeOutputGuard`                    |
| `SourceFetcher`                           | `kind`, `fetch(source, window, signal)`                                                                                          | `createRssFetcher`, `createGithubReleasesFetcher`                                                             | `FakeSourceFetcher`                                    |
| `Delivery`                                | `id` (`markdown`, `email`, `slack`), `sendDigest(msg)`, `sendFailure(note)`                                                      | `createMarkdownFileDelivery`, `createSmtpDelivery`, `createSlackDelivery`                                     | `CapturingDelivery`                                    |
| `RunStore`                                | `acquireLock`, `hasSentDigest`, `saveArtifact`, `readArtifact`, `saveRunRecord`, `getRunRecord`, `sentUrls`, `listRuns`, `prune` | `createFsRunStore`                                                                                            | `MemoryRunStore` (evals use their own in-memory store) |

`Logger`, `Tracer` and `Clock` in `src/shared` are smaller interfaces with the same role:
`src/observability` implements the first two; tests inject a fixed clock.

---

## 5. Data and storage

### 5.1 Layout under `dataDir` (default `data/`)

```text
data/
  digest.lock                  run lock (+ digest.lock.takeover, briefly, during a takeover;
                               a killed run can leave digest.lock.<pid>.<uuid>.tmp, swept after 10 min)
  runs/
    2026-W43/
      items.json               collected items, after the window, caps and dedupe
      scores.json              one Classification per item that passed the input guards
      drafts.json              { drafts, failures, rejections }: every writer's prepared draft (2.5)
      digest.md                the winning digest as Markdown
      run.json                 the RunRecord
      error.json               only on failure: step, name, message, time, stack
  digests/                     markdown delivery (default delivery.markdown.dir = data/digests)
    2026-W43.md
    2026-W42.failed.md
```

Every file is written atomically (temp file, fsync, rename). Week ids are validated before they
become folder or file names. `delivery.markdown.dir` is its own setting, not resolved against
`dataDir`.

### 5.2 RunRecord (`run.json`, `RunRecordSchema`)

| Field                     | Meaning                                                                                                                                                                                                                                                                            |
| ------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `runId`                   | ISO week, e.g. `2026-W43`                                                                                                                                                                                                                                                          |
| `status`, `dryRun`        | see 2.10                                                                                                                                                                                                                                                                           |
| `startedAt`, `finishedAt` | ISO timestamps                                                                                                                                                                                                                                                                     |
| `profile`, `modelsByRole` | profile name and the tag(s) per role (`write` is a list, `judge` may be null)                                                                                                                                                                                                      |
| `timings[]`               | `{ step, ms }` per step that ran                                                                                                                                                                                                                                                   |
| `counts`                  | `collected`, `afterGuardInput`, `classified`, `afterProcess`, `selected`, `digestItems`. `afterProcess` is the items that passed the process filters (`selected` plus the ones cut as `below-top-n`); it is absent in older records and when the run ended before the process step |
| `failedSources[]`         | `{ sourceId, error }`                                                                                                                                                                                                                                                              |
| `disabledGuards[]`        | guard check ids that were off or missing                                                                                                                                                                                                                                           |
| `drafts[]`                | `{ writer, passed, rejectedBy[], score? }`; `score` = `{ writer, score, byCriterion }`                                                                                                                                                                                             |
| `winner`                  | winning writer tag, or null                                                                                                                                                                                                                                                        |
| `sentUrls[]`              | URLs delivered this run, set once any channel took the digest; read back for cross-week dedupe                                                                                                                                                                                     |
| `deliveredTo[]`           | channels that took the digest (`markdown`, `email`, `slack`); optional, set on a `sent` run and on a partly delivered `failed` run. A `failed` run with a non-empty list is what a rerun resumes (2.9). Such a week counts in cross-week dedupe like a `sent` one                  |
| `error?`                  | `{ message, step? }` on failure                                                                                                                                                                                                                                                    |

### 5.3 Kept and pruned

- Kept: the current week and the previous `keepWeeks` (12) weeks in full; `digest.md` of every
  older week; everything in `delivery.markdown.dir` (never pruned).
- Pruned after each finished run: all files except `digest.md` in older week folders. Without
  `run.json`, those weeks drop out of `digest history` and of cross-week dedupe.
- `skipped` runs save nothing and do not prune.

### 5.4 Domain types

```mermaid
classDiagram
  class Source {
    +string id
    +string kind
    +string url
  }
  class Item {
    +string id
    +string url
    +string title
    +string summary
    +string publishedAt
  }
  class Classification {
    +number relevance
    +string area
    +number hype
    +number minorRelease
  }
  class ScoredItem
  class GuardVerdict {
    +string check
    +boolean flagged
  }
  class Draft {
    +string writer
  }
  class Digest {
    +string weekId
    +string headline
    +string intro
  }
  class DigestItem {
    +string itemId
    +string url
    +string summary
    +string whyItMatters
  }
  class DraftOutcome {
    +string writer
    +boolean passed
    +List~string~ rejectedBy
  }
  class JudgeScore {
    +number score
    +Map byCriterion
  }
  class RunRecord {
    +string runId
    +string status
    +string winner
    +List~string~ sentUrls
  }
  Source "1" --> "*" Item : collect
  Item <|-- ScoredItem
  ScoredItem "1" *-- "1" Classification
  Item ..> GuardVerdict : input guards
  Draft ..> GuardVerdict : output guards
  Draft "1" *-- "1" Digest
  Digest "1" *-- "3..5" DigestItem
  DigestItem --> ScoredItem : itemId and url
  RunRecord "1" *-- "*" DraftOutcome
  DraftOutcome --> JudgeScore
  DraftOutcome ..> Draft : outcome of
```

Read left to right as the chain: a `Source` yields `Item`s, classify turns them into
`ScoredItem`s, each writer turns the selected ones into a `Draft` holding a `Digest`, and the
run record keeps one `DraftOutcome` per writer. Only key fields are shown; `src/core/schemas.ts`
and 5.2 have the rest. `GuardVerdict`s are not stored in `run.json`, only the ids of the checks
that rejected a draft (`rejectedBy`).

---

## 6. Containerisation

### 6.1 The image (`Dockerfile`)

| Aspect               | Value                                                                                                                                                                                             |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Base                 | `node:24-slim`, pinned by sha256 digest (`ARG NODE_IMAGE`)                                                                                                                                        |
| Stages               | `base` (corepack, `package.json` + lockfile) → `prod-deps` (`pnpm install --frozen-lockfile --prod`) and `build` (full install, `src`, `scripts`, `evals`, `pnpm build` with esbuild) → `runtime` |
| Runtime contents     | prod `node_modules`, `dist/`, `evals/` (for `digest eval`), empty `/app/data` owned by `node`                                                                                                     |
| User                 | `node` (non-root)                                                                                                                                                                                 |
| Entrypoint / command | `ENTRYPOINT ["node", "dist/cli.js"]`, `CMD ["serve"]`                                                                                                                                             |
| Not in the image     | `.env`, `digest.config.json`, `data/`, `docs/plan`, `.claude`, `.git` (`.dockerignore`)                                                                                                           |

`docker/validate.sh` checks the Compose file per profile, that `pull-models.sh` matches
`profiles.ts`, and that the image builds, lists every command, runs as non-root and contains no
`.env` or config.

### 6.2 Compose services and profiles (`docker-compose.yml`, project `eng-digest`)

| Service      | Profile   | Image                                         | Role                                                                                                                                                                                         |
| ------------ | --------- | --------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `digest`     | default   | `eng-digest:local` (built)                    | the app; `serve` by default; `restart: unless-stopped`, `init: true`                                                                                                                         |
| `ollama`     | `linux`   | `ollama/ollama:0.40.3` (pinned digest)        | bundled Ollama; models in volume `ollama-models`; healthcheck `ollama list`; `gpus: all` commented out                                                                                       |
| `model-pull` | `linux`   | same Ollama image                             | one-shot `docker/pull-models.sh`: pulls `clef:latest`, `granite4.1-guardian:8b` and the writers from `models.writers` (default `gemma4:31b`); skips present models unless `REFRESH_MODELS=1` |
| `jaeger`     | `tracing` | `jaegertracing/jaeger:2.21.0` (pinned digest) | trace UI on `127.0.0.1:16686`; OTLP on `jaeger:4318` inside the network                                                                                                                      |

- **Mac mode** (default profile): only `digest` runs. `OLLAMA_URL` must point to the Ollama app
  on the host, `http://host.docker.internal:11434`; `extra_hosts` maps that name on Linux too.
- **Linux mode** (`--profile linux`): `digest` waits for a healthy `ollama` and a finished
  `model-pull` (both `required: false`, so the default profile ignores them). `OLLAMA_URL`
  defaults to `http://ollama:11434`.
- **Tracing** (`--profile tracing`): adds Jaeger. The app traces only when
  `OTEL_EXPORTER_OTLP_ENDPOINT=http://jaeger:4318/v1/traces` is set in `.env` or the shell.

### 6.3 Volumes, config, secrets and environment

| Item                             | How                                                                                                                                    |
| -------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| `./data` → `/app/data`           | bind mount: runs, lock, digests                                                                                                        |
| `./digest.config.json`, `./.env` | single-file bind mounts into `/app`, `create_host_path: false`, so both must exist first                                               |
| `ollama-models`                  | named volume for the bundled Ollama                                                                                                    |
| Secrets                          | the app reads the mounted `.env`; there is no `env_file`, so secrets do not show in `docker inspect` or `docker compose config`        |
| Environment                      | `OLLAMA_URL` (default `http://ollama:11434`), `TZ` (default `UTC`), and passthrough `DIGEST_HOST_OS` and `OTEL_EXPORTER_OTLP_ENDPOINT` |
| User                             | `${DIGEST_UID:-1000}:${DIGEST_GID:-1000}`, so on Linux the container can write `./data` and read a `chmod 600` `.env`                  |
| Hardening                        | `cap_drop: ALL`, `no-new-privileges:true`, non-root, pinned image digests                                                              |

### 6.4 `serve` versus one-shot commands

- `docker compose up -d` starts `digest serve`: the in-process scheduler (croner) fires on
  `schedule.cron` (default `45 7 * * 1`, Monday 07:45) in `schedule.timeZone`, catches up a
  missed week on start (8.2), skips a tick while a run is going, retries a tick that finds the
  run lock held and a run that ends `failed` (8.2), limits a run to 3 h, and on SIGTERM/SIGINT
  waits for the running digest before closing. A second signal stops the run after its current
  step; a third ends the process. Compose gives it `stop_grace_period: 90m`: a measured `quality`
  run took about 59 min, and the rest is a margin. A run that outlasts it is killed, and the next
  start takes over its lock within 5 min.
- One-shot: `docker compose run --rm digest <command>` starts a new container from the same
  image, e.g. `run --dry-run`, `doctor`, `history`, `eval`. `init` needs no Ollama:
  `docker compose run --rm --no-deps digest init`.
- Without Docker: `digest init` prints a launchd plist (macOS), a systemd user timer with
  `Persistent=true` (Linux) or a `schtasks` line (Windows) that calls `digest run`. These fire
  in the machine's local time, not `schedule.timeZone`.

### 6.5 Deployment on a Mac

```mermaid
flowchart TB
  subgraph MAC["macOS host, Apple silicon"]
    OLLAPP["Ollama app on port 11434, Metal GPU"]
    FILES[("digest.config.json, .env, data/")]
    LAUNCHD["launchd agent (native path)"]
    HOSTCLI["digest CLI on host Node 24 (native path)"]
    subgraph VM["Docker Desktop Linux VM"]
      DIG["digest container: node dist/cli.js serve"]
      ONE["one-shot container: docker compose run"]
      JAE["jaeger container (profile tracing)"]
    end
  end
  NET["Feeds, GitHub, SMTP server, Slack"]
  DIG -->|"http://host.docker.internal:11434"| OLLAPP
  ONE -->|"http://host.docker.internal:11434"| OLLAPP
  FILES -.->|"bind mounts"| DIG
  FILES -.->|"bind mounts"| ONE
  DIG -->|"OTLP/HTTP to jaeger:4318"| JAE
  DIG --> NET
  LAUNCHD -->|"weekly: digest run"| HOSTCLI
  HOSTCLI -->|"http://localhost:11434"| OLLAPP
  HOSTCLI --> FILES
  HOSTCLI --> NET
```

Two ways to run on a Mac. Docker mode runs the app in the Linux VM and reaches the Ollama app
on the host, because Ollama in Docker cannot use the Apple GPU or MLX. Native mode has launchd
call the CLI directly. In Docker mode `DIGEST_HOST_OS` and `DIGEST_HOST_ARCH` (exported by
`make docker-*`) tell the app that the host is a Mac, so the MLX profiles resolve as they do on
the host (D1).

### 6.6 Deployment on Linux

```mermaid
flowchart TB
  subgraph LINUX["Linux host"]
    FILES[("digest.config.json, .env, data/")]
    GPU["NVIDIA GPU, optional"]
    subgraph PROJ["Compose project eng-digest, profile linux"]
      DIG["digest: serve"]
      OLLSVC["ollama: ollama/ollama:0.40.3"]
      PULL["model-pull: one-shot pull-models.sh"]
      VOL[("volume ollama-models")]
      JAE["jaeger (profile tracing)"]
    end
  end
  NET["Feeds, GitHub, SMTP server, Slack"]
  PULL -->|"ollama pull"| OLLSVC
  OLLSVC --- VOL
  GPU -.->|"only if gpus: all is enabled"| OLLSVC
  DIG -->|"http://ollama:11434"| OLLSVC
  FILES -.->|"bind mounts"| DIG
  FILES -.->|"config, read-only"| PULL
  DIG -->|"OTLP/HTTP"| JAE
  DIG --> NET
```

Everything runs in Compose. `model-pull` reads `models.writers` from the mounted config and
pulls once into the named volume, so later runs work offline. `digest` starts only after Ollama
is healthy and the pull has finished. Without the GPU line the models run on the CPU.

### 6.7 Logical view → deployment view

| Logical component (section 4)    | Mac, Docker mode                   | Mac, native mode         | Linux, Compose `linux`             | AWS (proposed, section 7)         |
| -------------------------------- | ---------------------------------- | ------------------------ | ---------------------------------- | --------------------------------- |
| Scheduler entry                  | `digest` container (`serve`)       | launchd → `digest run`   | `digest` container (`serve`)       | EventBridge Scheduler             |
| CLI entry                        | one-shot `digest` container        | host process             | one-shot `digest` container        | handler or task override          |
| Composition root, core, adapters | Node process in `digest` container | host Node process        | Node process in `digest` container | Lambda function or Fargate task   |
| ModelProvider target             | Ollama app on host                 | Ollama app on host       | `ollama` container                 | Bedrock, or Ollama on EC2 GPU     |
| RunStore                         | `./data` bind mount                | `./data`                 | `./data` bind mount                | S3 + DynamoDB                     |
| Markdown delivery                | `./data/digests`                   | `./data/digests`         | `./data/digests`                   | S3                                |
| Config and secrets               | bind-mounted files                 | files in the working dir | bind-mounted files                 | S3/SSM/AppConfig, Secrets Manager |
| Logs                             | container stdout                   | stdout                   | container stdout                   | CloudWatch Logs                   |
| Traces                           | `jaeger` container                 | any OTLP endpoint        | `jaeger` container                 | ADOT → X-Ray                      |

---

## 7. Mapping to AWS (proposed)

Nothing here is built. The spec treats AWS as a later target for when a team, not one reader,
needs the digest: "only adapters and one handler change". This section extends that path.

### 7.1 Service mapping

| Local service or component                      | AWS service                                           | Notes                                                                                                                                                                                                                                                             |
| ----------------------------------------------- | ----------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Scheduler (croner in `serve`, launchd, systemd) | EventBridge Scheduler                                 | Cron with a time zone. No machine is ever off, so catch-up matters less; use the scheduler's retry policy and a DLQ instead.                                                                                                                                      |
| The digest process                              | ECS Fargate scheduled task, or Lambda container image | See 7.2.                                                                                                                                                                                                                                                          |
| Ollama                                          | Amazon Bedrock, or Ollama on EC2 GPU                  | See 7.3.                                                                                                                                                                                                                                                          |
| `fsRunStore` artifacts and `run.json`           | S3 (`runs/<week>/...`)                                | Same layout as section 5.                                                                                                                                                                                                                                         |
| Run lock and idempotency                        | DynamoDB conditional writes, or S3 conditional writes | DynamoDB: conditional put on a `lock` item with a TTL, conditional delete on release, a conditional "sent" marker per week. S3: `If-None-Match` puts can create a lock object; stale-lock takeover needs compare-and-swap on the ETag. Verify current S3 support. |
| Markdown delivery                               | S3 (`digests/<week>.md`)                              | A new adapter that keeps `id: 'markdown'`.                                                                                                                                                                                                                        |
| SMTP                                            | Amazon SES                                            | Zero code: point `delivery.email` at the SES SMTP endpoint with SMTP credentials. Better: an SES API adapter on an IAM role, so there is no password.                                                                                                             |
| Slack webhook                                   | unchanged                                             | Needs internet egress.                                                                                                                                                                                                                                            |
| `.env` secrets                                  | Secrets Manager or SSM Parameter Store (SecureString) | `loadConfig` already prefers process env over `.env`; ECS can inject secrets as env vars. Lambda needs the Parameters and Secrets extension or a fetch in the handler.                                                                                            |
| `digest.config.json`                            | S3, SSM Parameter Store or AppConfig                  | `loadConfig` reads a file path, so the handler downloads it to `/tmp` first.                                                                                                                                                                                      |
| pino JSON logs                                  | CloudWatch Logs                                       | stdout is already JSON; add metric filters on `status`.                                                                                                                                                                                                           |
| OTel → Jaeger                                   | ADOT collector → X-Ray                                | Same OTLP/HTTP exporter; only `OTEL_EXPORTER_OTLP_ENDPOINT` changes.                                                                                                                                                                                              |
| Failure note                                    | SNS + CloudWatch alarms, plus the in-app note         | Alarm on task exit code 1 or a `status=failed` metric. Exit codes 2 and 3 are not failures and must not page.                                                                                                                                                     |
| Image registry                                  | ECR                                                   | Turn on image scanning; this also closes the spec's "image scan" gap.                                                                                                                                                                                             |
| Outbound feed access                            | NAT gateway plus an egress filter                     | Feeds, GitHub and Slack are on the internet. To keep the host allowlist, add Route 53 Resolver DNS Firewall or Network Firewall domain rules. Use VPC endpoints for Bedrock, S3, DynamoDB and Secrets Manager.                                                    |

### 7.2 Lambda or Fargate

| Factor              | Lambda (container image)                     | ECS Fargate scheduled task         |
| ------------------- | -------------------------------------------- | ---------------------------------- |
| Time limit          | 15 minutes, hard                             | none                               |
| Fit to today's code | needs `handlers/lambda.ts`                   | runs `node dist/cli.js run` as is  |
| Exit codes          | none; return the status and emit a metric    | task exit code in ECS events       |
| Overlap             | set reserved concurrency to 1, keep the lock | keep the lock                      |
| Cold start          | irrelevant for a weekly job                  | slower task start, also irrelevant |
| GPU                 | no                                           | no (self-hosted models need EC2)   |

Run time per profile is not measured yet (the spec leaves it to `digest eval`). The code's
limits show the risk: one writer call may take 600 s per attempt, with 2 retries, so one slow
writer can pass Lambda's 900 s before the judge runs. Start with Fargate; move to Lambda only if
`runTime` from `digest eval` on the AWS profile shows a wide margin under 15 minutes.

The spec's collector/worker Lambda split fits the ports without core changes: the collector
calls the exported `collectStep` and writes `items.json` to S3; the worker runs `runDigest` with
a `SourceFetcher` that serves those items, as the eval harness does for recorded weeks. The
worker still runs every model step in one invocation, so the 15-minute limit still applies.
Splitting per step (Step Functions) would need `runDigest` to resume from saved state: a core
change.

### 7.3 Model roles on Bedrock

| Role (call)                                    | Local model           | Bedrock fit          | Options                                                                                                                                                                                             |
| ---------------------------------------------- | --------------------- | -------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| write (`generate` + JSON Schema)               | gemma4, nemotron      | clean                | Bedrock chat models through the Converse API, with structured output by tool use or JSON mode. Keep two families in the panel.                                                                      |
| classify (`decide`)                            | clef, strands-decider | no direct equivalent | (a) `BedrockModelProvider.decide()` emulates decisions with one structured `generate` per call; probabilities become 0/1 or self-reported. (b) Wire the existing `generate` batch mode of classify. |
| guardPolicy: clefPolicy, clefRubric (`decide`) | clef, strands-decider | no direct equivalent | (a) Decide emulation on a chat model. (b) Bedrock Guardrails `ApplyGuardrail` with the prompt-attack filter and content filters for clefPolicy. Hype and off-task have no Guardrails filter.        |
| guardRisk: graniteRisk (`generate`)            | granite4.1-guardian   | partial              | Guardrails content filters (hate, insults, sexual, violence, misconduct) and prompt-attack; a different taxonomy from granite's jailbreak and harm.                                                 |
| guardRisk: graniteGroundedness (`generate`)    | granite4.1-guardian   | close                | Guardrails contextual grounding check, with the source item as the grounding source and the digest item as the content; thresholds on its scores.                                                   |
| judge (`decide`, scores)                       | clef                  | no direct equivalent | Decide emulation on a model from a family no writer uses.                                                                                                                                           |

clef, granite4.1-guardian, strands-decider and the Ollama `/v1/systemone` decide endpoint have
no Bedrock counterpart. Three options:

1. **Emulate `decide` on Bedrock** in the adapter. The port stays the same, but thresholds tuned
   on real probabilities must be retuned.
2. **Bedrock Guardrails as Guard adapters** for some checks. Guardrails is a guard, not a model,
   so it fits `InputGuard`/`OutputGuard` directly.
3. **Self-host** the same models on an EC2 GPU instance. `createOllamaProvider` and the decide
   endpoint stay unchanged, so scores stay comparable to the Linux fallback profile. SageMaker
   would need a custom container with Ollama and its own adapter. `strands-decider` and the MLX
   tags need Apple silicon, so the `fast` and `light` profiles cannot run on Linux GPUs at all.

Before building, verify Guardrails features, model availability and structured-output support
in the target region against current AWS documentation.

### 7.4 New adapters, and what stays the same

New, all behind existing ports and wired in a new composition root (for example `buildAwsApp`):

- `BedrockModelProvider` (`ModelProvider`): `generate` via Converse; `decide` emulated; `health`
  confirms the configured model ids are accessible.
- `BedrockGuardrailGuard` (`InputGuard`/`OutputGuard`), optional.
- `S3RunStore` (`RunStore`), with the lock and the sent marker in DynamoDB. `prune` can tag
  non-`digest.md` objects and let an S3 lifecycle rule expire them.
- `S3MarkdownDelivery` (`Delivery`, id `markdown`) and `SesDelivery` (`Delivery`, id `email`).
- A config source that fetches `digest.config.json` to `/tmp`.

`src/core` logic does not change. Some frozen shared definitions need new values, which is a
change on `main` but not to the chain:

- `ProfileNameSchema` and `profiles.ts` need an AWS profile; `ModelProfile` has Ollama-only
  fields (`minOllamaVersion`, `requiresAppleSilicon`).
- `GuardCheckIdSchema` names checks after models (`clefPolicy`, `graniteRisk`, ...). A
  Guardrails guard must reuse one of those ids, or the enum (and `guards.*.checks` in config)
  grows.
- The health-check error in `runDigest` says "Ollama is not reachable" and suggests
  `ollama pull`; the wording should become vendor-neutral.

### 7.5 `handlers/lambda.ts` (planned)

The spec lists it as the optional AWS entry that calls the same `runDigest`. Proposed shape:

```ts
// Proposed, not in the repo.
export async function handler(event: { weekId?: string; force?: boolean; dryRun?: boolean }) {
  const loaded = await loadConfig({ configPath: await downloadConfigToTmp() });
  const app = await buildAwsApp(loaded);
  try {
    const { record, exitCode } = await runDigest(app.deps, event);
    return { status: record.status, exitCode };
  } finally {
    await app.close();
  }
}
```

### 7.6 AWS deployment

```mermaid
flowchart LR
  SCHED["EventBridge Scheduler: weekly cron, time zone, retries"]
  ECR["ECR: digest image, scanned"]
  CFG["S3, SSM or AppConfig: digest.config.json"]
  subgraph VPC["VPC, private subnets"]
    TASK["Fargate task or Lambda: same image, runDigest"]
  end
  BR["Amazon Bedrock and Guardrails (VPC endpoint)"]
  S3["S3: runs/ and digests/"]
  DDB["DynamoDB: lock, sent marker"]
  SM["Secrets Manager or SSM"]
  SES["Amazon SES"]
  NAT["NAT gateway + DNS Firewall allowlist"]
  EXT["Feeds, GitHub, Slack"]
  CWL["CloudWatch Logs"]
  ADOT["ADOT collector"]
  XRAY["AWS X-Ray"]
  ALARM["CloudWatch alarm"]
  SNS["SNS"]
  SCHED -->|"starts"| TASK
  ECR -->|"image"| TASK
  CFG -->|"config"| TASK
  SM -->|"secrets as env"| TASK
  TASK --> BR
  TASK --> S3
  TASK --> DDB
  TASK --> SES
  TASK --> NAT
  NAT --> EXT
  TASK -->|"stdout JSON"| CWL
  TASK -->|"OTLP"| ADOT
  ADOT --> XRAY
  CWL -->|"status=failed metric"| ALARM
  ALARM --> SNS
```

The scheduler starts one task per week from the ECR image. The task reads config and secrets,
talks to Bedrock, S3, DynamoDB and SES over AWS endpoints, and reaches the internet only through
the NAT gateway and the egress allowlist. Logs and traces leave on the right; an alarm on failed
runs pages through SNS.

### 7.7 Trade-offs

- **Cost.** Local runs cost nothing at the margin. On AWS, Bedrock bills per token; the caps
  (3.1) bound the volume: 24 sources × 20 items is at most 480 items, each with up to about four
  model calls on a short state, plus a few writer and judge calls. For a weekly job the fixed
  costs will likely dominate: a NAT gateway per hour, Secrets Manager per secret, and an
  always-on GPU instance if models are self-hosted. Lambda outside a VPC avoids the NAT gateway
  but loses the DNS-level egress allowlist. Get real numbers from one `digest eval` run with
  token counts before deciding.
- **Cold start.** Not a concern for a weekly job. Self-hosted Ollama on EC2 adds model load time
  on every start if the instance is stopped between runs.
- **Model parity.** Bedrock models are not the local tags. Every eval number is tied to a
  profile, so the AWS profile needs its own `digest eval --profile` run: the four hard gates
  (link validity, attack handling, groundedness, format) must stay at 100%, the thresholds
  (`guardFlag`, `minRelevance`, `maxHype`, `maxMinorRelease`) must be retuned on the labelled
  cases, and the judge must be recalibrated against the 10 hand-graded digests and still come
  from a family no writer uses.
- **Data residency.** Feed content is public; digests, recipients and run history are not. Pick
  a region where the chosen models run in-region; cross-region inference profiles may route
  requests elsewhere in the same geography. Encrypt S3, DynamoDB and secrets with KMS.

---

## 8. Non-functional design

### 8.1 Security invariants and where they are enforced

| Invariant (spec, `.claude/rules/security.md`) | Enforced by                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| --------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Item text is data, not instructions           | `wrapUntrusted` + `UNTRUSTED_DATA_RULE` in classify, write, guard and judge prompts; `neutralize()`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| No model has tools or network                 | `ModelProvider` exposes only `generate`, `decide`, `health`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| Link check and format check always run        | `runDigest.codeCheck` calls both for every draft; no config field exists                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| Only collected URLs                           | write-step provenance (URL replaced by the source URL) plus the link check                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| Fixed recipients                              | SMTP `to` copied from config at construction; webhook from `.env`; markdown dir from config. Model text reaches message bodies and the email subject, never an address or path.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| Network allowlist                             | sources list; a feed fetch follows a redirect only to the source's own host (apex = `www.`; `api.github.com` for GitHub sources), never to http, another port or a URL with credentials, at most 5 hops, 5 MiB body cap; a source URL may not hold a username or password; an article page fetched for a missing summary may also redirect to a host of the default source list (https, same port); GitHub host checks; Slack `redirect: 'error'` and an `https:` webhook (D14)                                                                                                                                                                                                                                                                                                  |
| Secrets never logged or stored                | `SecretsSchema`; one redactor (`createRedactor`) serves the logger, the tracer, the config loader and CLI output, and hides each secret value raw, URL-encoded and JSON-escaped, and the path of the Slack webhook; the run record, every artifact, and every digest, subject and failure note are redacted again just before they are saved or sent (`app/redacting.ts`), and a record that no longer fits its schema after redaction is not saved; delivery errors rebuilt as a `DeliveryError` that keeps only identifier fields (code, status, SMTP reply) and a copy of the cause chain with every message and name redacted, never the original errors; GitHub token redacted; `init` writes `.env` as 0600; `doctor` warns on a readable `.env`; no `env_file` in Compose |
| Guards switchable, checks not                 | `config.guards`; `disabledGuards` in `run.json` and the digest footer                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| Guards fail closed                            | unparsable granite output flags; a missing clef answer is an error                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| Container hardening                           | non-root user, `cap_drop: ALL`, `no-new-privileges`, image digests pinned                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| Supply chain                                  | frozen lockfile, pinned base images, `pnpm audit --prod --audit-level high` and a Trivy image scan in CI (Trivy 0.75.0 pinned by digest, run from its own image, fails on HIGH and CRITICAL)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |

### 8.2 Resilience

| Concern                        | Mechanism                                                                                                                                                                                                                                                                                                                                                                                                                               |
| ------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Feed failure                   | 10 s timeout, 2 retries, backoff from 500 ms, on `FetchError.retryable` (timeouts, network errors, 5xx, 408, 429); failed source recorded and skipped                                                                                                                                                                                                                                                                                   |
| Model call failure             | per-role timeout per attempt, 2 retries with backoff (1-10 s) on retryable errors only; 4xx not retried                                                                                                                                                                                                                                                                                                                                 |
| Invalid model JSON             | one repair attempt, then the step (or that writer) fails                                                                                                                                                                                                                                                                                                                                                                                |
| One writer fails               | the next writer still runs; every writer failing is `failed` (step `write`); drafts that all fail the checks or guards are `blocked`                                                                                                                                                                                                                                                                                                    |
| Ollama down or a model missing | health check before collect; fails in seconds with a fix ("ollama pull ...")                                                                                                                                                                                                                                                                                                                                                            |
| Concurrent runs                | file lock with a heartbeat; a stale lock (dead pid, reused pid, heartbeat 5 min old, no-heartbeat lock 6 h old, unreadable) is taken over under a guard file; orphaned temp files are swept                                                                                                                                                                                                                                             |
| Crash mid-write                | atomic temp-file + rename writes for every artifact, record and digest                                                                                                                                                                                                                                                                                                                                                                  |
| Missed week                    | `serve` catches up on start if this week's slot passed: it runs a week with no record or a `failed` or `dry-run` one, and skips `sent`, `quiet` and `blocked`; systemd timers use `Persistent=true`                                                                                                                                                                                                                                     |
| Overlapping ticks              | croner `protect: true` plus the executor skips a tick while a run is going                                                                                                                                                                                                                                                                                                                                                              |
| Lock held at a tick            | a tick or catch-up that finds the run lock held (a manual `digest run`) retries every 5 min for up to 2 h, then logs an error and gives up; `stop()` cancels a pending retry; other failures are not retried. A failure note held back by an earlier attempt is sent when the lock retries run out                                                                                                                                      |
| Partial delivery               | every channel is tried and recorded in `deliveredTo`; a rerun sends the saved digest to the missing channels only (2.9)                                                                                                                                                                                                                                                                                                                 |
| Judge failure                  | the first passing draft in writer order wins, with a warning and no scores                                                                                                                                                                                                                                                                                                                                                              |
| Aborted run                    | `RunOptions.signal` is checked before each step; the run ends `failed` and releases the lock. A step in flight finishes first, so a run can overshoot its limit by that step                                                                                                                                                                                                                                                            |
| Failed scheduled run           | a tick or catch-up run that returns `failed` is tried again at most twice, 30 min apart, on the same week (`digest serve` asks for it). Not retried: a run that hit its time limit, a refused resume that needs `--force`, or a thrown error (those are logged). The week sends one failure note: an attempt that will be retried holds its note, the last attempt sends it, and `onGiveUp` sends it once if the retry never runs (2.8) |
| Run time limit                 | each attempt gets a signal that fires after 3 h with `run timed out after 3 h`; the run ends `failed`, releases the lock, and is not retried (a slow or hung model is not a blip, and two more runs would hold the GPU for hours). The next restart catches the week up                                                                                                                                                                 |
| Transient delivery failure     | a channel retries twice, after 5 s and 10 s, only when nothing was sent: connect-phase errors, HTTP 429 and 5xx, SMTP 421, 450 and 451, read from typed facts (2.8)                                                                                                                                                                                                                                                                     |
| Shutdown                       | the first SIGINT or SIGTERM stops new ticks and waits for the run; a second stops the run after its current step (it ends `failed`); a third ends the process. A failure note held back for a retry that the stop cancels is sent at once                                                                                                                                                                                               |
| Alerting                       | failure note on every channel, best effort, one per failed week in `digest serve` (2.8); if `run.json` cannot be saved, a note is sent first, then the run fails                                                                                                                                                                                                                                                                        |
| Telemetry outage               | a failed trace flush is logged and never fails the run                                                                                                                                                                                                                                                                                                                                                                                  |

### 8.3 Observability

- **Logs**: pino JSON on stdout with `service: eng-digest`. Run-scoped lines carry `runId` and
  `step`. Each model call logs `role`, `model`, `op`, `latencyMs`, `attempts`, `inputTokens`,
  `outputTokens`, and, like the retry and abort lines of the Ollama adapter and the fetcher
  warnings, the `runId` and, inside a step, the `step` (D8, W5-14). Level from `LOG_LEVEL`. The
  model provider and the fetchers are built once, but `digest serve` runs many weeks, so the
  container gives them a logger that looks the run up on every line (`perRunLogger` in
  `app/container.ts`). `deps.tracer` wraps the real tracer: a span whose `runId` attribute is a
  string runs inside an `AsyncLocalStorage` holding `logger.child({ runId, step })`, or
  `child({ runId })` for the `runDigest` span, and the scope ends with the span. Core opens its
  `runDigest` span with `runId` and every step span with `runId` and `step`. So a call in a step
  logs both, a call in a run outside a step logs `runId`, and a call outside any run logs neither,
  and two weeks in one process never see each other's id. The store, the deliveries and the
  scheduler keep the root logger. Redaction is unchanged: every line still ends in the redacting
  root logger.
- **Traces**: OpenTelemetry only when `OTEL_EXPORTER_OTLP_ENDPOINT` is set: one `runDigest` span
  and one span per step, and inside the steps one `model.generate` or `model.decide` span per
  model call (attributes: role, and the model when the caller named one; its length is the
  latency) with a short `model.usage` span in it (role, model, latency, input and output tokens).
  No prompt, state, question or answer goes into a span. Exported over OTLP/HTTP with a batch
  processor; Jaeger via the Compose `tracing` profile.
- **Run history**: `run.json` per week and `digest history` (week, status, items, duration,
  winner). `digest run` prints a summary with failed sources and rejected drafts.
- **Health**: `digest doctor` checks config, Ollama and its version (a development build or a
  pre-release of the minimum is a warning), Apple silicon (and the heavy fallback of `light` off
  a Mac), the models the run uses (`modelsInUse`), the `think` setting per role, every source (a
  1-day fetch with a 10 s timeout), delivery secrets and the markdown folder, the `.env` mode,
  `.env` values cut at a `#`, guards and the data dir (a file or a dangling symlink there fails),
  and prints a fix per problem.
- **Quality**: `digest eval` scorecards under `evals/scorecards`. The replay serves each source up
  to its production cap (`maxItems`, else `maxItemsPerSource`); a label outside that window is
  "not visible" and counted in `detail.notVisible`, not a load failure. The format and link
  metrics carry `byWeek` detail (status and the first problems of each week), stability keeps the
  item ids of every run, and `guardAttackRecall` (soft gate, 90%) shows how many attack cases the
  input guards flagged on their own. Two soft metrics check the fetchers against recorded real
  responses of the 24 default sources in `evals/sources/` (a hand-checked `expected.json` each):
  `sourceParse` (items parsed over items expected, gate 95%) and `sourceSummaryFill` (parsed items
  with a summary of at least 40 characters, gate 90%). `pnpm tsx evals/recordSources.ts` records
  them again, and `--pages` also records the article pages that fill an empty summary. The
  threshold sweep (`evals/tuneThresholds.ts`) picks on a training split and also
  scores a held-out one (the two newest weeks, every third classifier case), and warns when
  filter accuracy, classifier accuracy or false blocks differ by more than 0.1. `digest eval`
  prints the weeks with problems and the item ids of each stability run, and writes
  `evals/scorecards/<date>-<profile>.json`, so a second run on the same day overwrites the file.
  When `EVAL_JUDGE` names a model, set in `.env` or the shell (the shell wins), it scores the
  winning digests of a profile that has no judge; those scores are reported, not gated. The judge
  provider is built by the container's `createModelProvider` with an eval logger (JSON on stdout,
  secrets redacted), and `assertJudgeInstalled` (`evals/judge/evalJudge.ts`) checks, once and
  before the first replay, that Ollama is reachable, lists the tag and reports the `decision`
  capability. Otherwise `digest eval` exits 1 with a `DigestError` and replays nothing. It never
  pulls. The check runs whenever `EVAL_JUDGE` is set, also for a profile that has a judge of its
  own. `toJudgeScore` has one implementation, in `steps/select.ts`, used by `select` and by the
  eval judge. The scorecard `detail` names cases (W5-11): `attackHandling` has
  `reachedDigest:<case>` for an attack item that reached a digest and `unchecked:<case>` for one
  no guard checked; `guardFalseBlocks` has `flagged:<guard>:<case>` for a clean control a guard
  flagged. The attack half is filled in every eval. The false-block half needs
  `GuardTally.flaggedCases`, which `evals/runEval.ts` does not fill yet (W6-06). All keys are
  optional, so older scorecards still load.

### 8.4 Limits

- **Single replica.** The lock is a file on local disk; no leader election, no shared store. Two
  machines sharing `data/` over a network file system are not supported.
- **One GPU, one model at a time.** Steps call models strictly in sequence, guard by guard and
  writer by writer, to fit `OLLAMA_MAX_LOADED_MODELS=1`. Within one guard, up to
  `GUARD_CONCURRENCY` calls can run at once; it is 1 (2.2). The largest model is about 19 GB.
- **Bounded input.** At most `sources × maxItemsPerSource` items (480 with the defaults), 4
  feeds fetched at once, at most 25 focus areas, 3-5 digest items, under 500 words.
- **Small context on the fast/light decision model.** `strands-decider` gets at most 10,000
  characters of state; longer states are trimmed.
- **Lock expiry.** The lock is kept alive by the process's heartbeat, not by the run's progress. A run that is suspended for more than 5 minutes (a sleeping laptop, a paused container) can lose its lock to another run, and then both can write the week's folder. A run that hangs but stays alive keeps its lock. The remaining limits are in the runbook (hard links are required).

---

## 9. Open questions and spec drift

### 9.1 Spec versus code

| #   | Topic                              | Spec says                                                        | Code does                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        | Status                                                                                                                                                                                                                                            |
| --- | ---------------------------------- | ---------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| D1  | Profile inside Docker on a Mac     | Mac mode uses the host Ollama app for the GPU and MLX models     | The loader resolves the profile from the host named by `DIGEST_HOST_OS` and `DIGEST_HOST_ARCH`, else from `process.platform`/`arch`, which is `linux` in a container (every profile then becomes the non-Mac fallback).                                                                                                                                                                                                                                                                                                                                                                                                          | Resolved (W2-06, 5403b9e): `make docker-*` exports the two variables.                                                                                                                                                                             |
| D2  | `light` on non-Mac                 | light fits a 16 GB machine                                       | The fallback replaces light too, so a "light" run on Linux or in Docker without the host override needs clef (18 GB) and `gemma4:31b`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           | Resolved by documenting (W5-02, 61321fc; README and this document: W5-07). `digest doctor` warns, `digest init` says so, and the README says `light` fits 16 GB only on Apple silicon. There is no separate non-Mac light fallback.               |
| D3  | Writer failures                    | "If no draft passes, the run fails"                              | A write step with no draft at all fails the run (`failed`, exit 1, step `write`). Drafts that exist and are all rejected by the checks or guards end `blocked`, exit 2, including a mix of the two.                                                                                                                                                                                                                                                                                                                                                                                                                              | Resolved (W2-08, 7f9a988).                                                                                                                                                                                                                        |
| D4  | Disabled guards and missing models | A guard can be switched off "when a model is not installed"      | The run's health check and `digest doctor` require `modelsInUse(profile, guards)`: the model of a guard role whose checks are all off is not required. `pull-models.sh` still pulls the whole fallback set.                                                                                                                                                                                                                                                                                                                                                                                                                      | Resolved (helper W5-00, 4419508; doctor W5-02, 61321fc; run health check W5-06, 3482989).                                                                                                                                                         |
| D5  | Classifier batching                | "score 10 items per call with a strict JSON schema"              | `decide` per item; the 10-item `generate` batch exists but `runDigest` never selects it and config has no switch.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                | Confirm: keep `decide` per item as the only path, or add a switch. This document follows the code.                                                                                                                                                |
| D6  | Step order                         | "guard-output and link check → deliver"                          | The write step drafts and runs the link and format checks (with one retry), then the output guards run on the drafts that passed, then select.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   | Accepted (F54): this document follows the code; the code order is cheaper.                                                                                                                                                                        |
| D7  | Tracing                            | one span per step and per model call                             | Spans for `runDigest` and each step, and a `model.generate` or `model.decide` span per model call with a `model.usage` span inside it (role, model, latency, tokens; never prompt text).                                                                                                                                                                                                                                                                                                                                                                                                                                         | Resolved (W5-09, be43bc5).                                                                                                                                                                                                                        |
| D8  | Log fields                         | run id, step, role, model, latency and tokens on every line      | Model-call lines (the `ollama call` line and its retry and abort lines) and fetcher warnings carry `runId` and, inside a step, `step`. The container gives the provider and both fetchers a logger that looks up the run in flight through the spans core opens with `runId` and `step` (8.3). The store, the deliveries and the scheduler keep the root logger, so their lines have neither.                                                                                                                                                                                                                                    | Resolved (W5-14, efdf932): both fields, with no `ModelProvider` port change.                                                                                                                                                                      |
| D9  | Minimum Ollama version             | MLX tags need Ollama 0.40.0+                                     | `quality` (two MLX writers) declared `minOllamaVersion: '0.35.1'`, so `doctor` accepted 0.35.x                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   | Resolved (W2-06, 5403b9e): every MLX profile declares 0.40.0.                                                                                                                                                                                     |
| D10 | Schedule time zone                 | Mondays 07:45, local time zone                                   | `init` did not write `schedule.timeZone`; it defaulted to the process zone, and Compose sets `TZ=UTC`. OS schedules fire in machine local time.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  | Resolved (W2-06, 5403b9e): `init` writes the host time zone into `schedule.timeZone`.                                                                                                                                                             |
| D11 | Model pulls                        | Compose pulls the models for the chosen profile on first start   | Only the `linux` profile pulls, and it pulls the fallback set (`clef:latest`, `granite4.1-guardian:8b`) plus `models.writers` (default `gemma4:31b`). Mac users pull in the host app; `digest doctor` prints the `ollama pull` line for each missing model.                                                                                                                                                                                                                                                                                                                                                                      | Accepted (F54): this document follows the code.                                                                                                                                                                                                   |
| D12 | One model in memory                | `OLLAMA_MAX_LOADED_MODELS=1`                                     | The code serializes calls. The variable was not set on the Compose `ollama` service or documented for the Mac app.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               | Resolved (W2-06, 5403b9e): set on the Compose `ollama` service and in the README.                                                                                                                                                                 |
| D13 | Supply chain                       | CI runs npm audit plus an image scan                             | CI runs `pnpm audit --prod --audit-level high` and an `image-scan` job: it builds the image and scans it with Trivy 0.75.0 (pinned by digest, run from its own image, no third-party action), failing on HIGH and CRITICAL.                                                                                                                                                                                                                                                                                                                                                                                                      | Resolved (W5-00, 97e55ad). The job has not run yet: it first runs on the first push, and it may stay red on HIGH findings in the base image that have no fix. Then add `--ignore-unfixed` (and `--scanners vuln`).                                |
| D14 | Network allowlist                  | only allowlisted hosts are contacted                             | A feed fetch follows a redirect only to the source's own host (apex = `www.`; `api.github.com` for GitHub sources), never from https to http, to another port or to a URL with credentials, at most 5 hops. A body over 5 MiB fails the source. A source URL may not hold a username or password. RSS item links are listed in the digest, never fetched.                                                                                                                                                                                                                                                                        | Resolved (W5-01, e9fcfc5; credentials W5-10, 094d8d3).                                                                                                                                                                                            |
| D15 | Source area hint                   | `Source.area` is "a hint for the classifier"                     | A run passes each source's `area` to the classifier as a trusted line `Source tag: <area>` (in the `decide` state and in the generate fallback). The classifier still picks the item's area from the focus areas itself. A source without an area gets the same prompt as before. There is no `cloud` focus area, though the 3 cloud sources are about 63% of the recorded volume.                                                                                                                                                                                                                                               | Resolved (W6-03, 77515b0 and e085050). The effect on the classifier is not measured yet.                                                                                                                                                          |
| D16 | Judge in evals                     | single-writer profiles: evals still use clef as the judge        | `select` skips the judge when `profile.judge` is null. `digest eval` builds an eval judge (`evals/judge/evalJudge.ts`) when `EVAL_JUDGE` names a model, set in `.env` or the shell (the shell wins): a provider from the container's `createModelProvider`, with an eval logger, whose profile has that model as its judge, shared by every profile of `--profile all`. `assertJudgeInstalled` checks before the replay that Ollama lists the tag as a decision model, and fails fast if not. The harness then scores each week's winner with it. The scores are reported, not gated, until a calibration exists for that judge. | Resolved in code (W5-04, 6bd9aa5; wiring W5-08, 625be34; `.env`, the shared provider and the install check W5-13, 5d6bc35). Not measured yet: the wave 5 run left `EVAL_JUDGE` unset, so writing quality and selection agreement are still empty. |
| D17 | Run artifacts                      | `items.json`, `scores.json`, `digest.md`, `run.json`             | Adds `drafts.json` (`{ drafts, failures, rejections }`) and `error.json`. Markdown delivery also writes `data/digests/<week>.md` and `<week>.failed.md`, outside the runs folder, never pruned, not relative to `dataDir`.                                                                                                                                                                                                                                                                                                                                                                                                       | Accepted (F54): this document follows the code. Whether digests should follow `dataDir` stays a maintainer choice.                                                                                                                                |
| D18 | Em dashes                          | the format check rejects em dashes                               | The write step rewrites em dashes to commas (`prepareDraft`) before the checks, and the prompt tells the writer to avoid them, so they rarely reject a draft.                                                                                                                                                                                                                                                                                                                                                                                                                                                                    | Accepted (F54): this document follows the code.                                                                                                                                                                                                   |
| D19 | CLI surface                        | `init`, `run [--since] [--dry-run]`, `eval`, `doctor`, `history` | Adds `serve`, `run --force`, `history -n`; `--since` accepts 1d-31d.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             | Accepted (F54): the README command table follows the code.                                                                                                                                                                                        |
| D20 | Exit codes                         | 0 sent, 1 failed, 2 blocked, 3 quiet                             | `dry-run` and `skipped` also exit 0; a held lock exits 1 with no record.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         | Accepted (F54): see 2.10.                                                                                                                                                                                                                         |
| D21 | Eval gates                         | every metric in the table has a gate                             | Four hard gates fail `digest eval`; the others (including `guardAttackRecall`, `sourceParse` and `sourceSummaryFill`) are "soft" (shown pass or fail, exit code unaffected).                                                                                                                                                                                                                                                                                                                                                                                                                                                     | Confirm this is intended.                                                                                                                                                                                                                         |
| D22 | AWS entry                          | `src/handlers/lambda.ts`                                         | Not present.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     | Planned: 7.5 keeps it as a proposal.                                                                                                                                                                                                              |

### 9.2 Container gaps (D1 above is the first)

| #   | Gap                                                               | Effect                                                                                                                                                                                                                                                                                                      |
| --- | ----------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| C1  | Makefile `docker-init`/`docker-up` do not export `DIGEST_HOST_OS` | Resolved (W2-06, 5403b9e). `init` in Docker writes `OLLAMA_URL=http://ollama:11434` on a Mac unless the user exports it; Mac mode then cannot reach Ollama.                                                                                                                                                 |
| C2  | `init` writes `.env` with temp file + rename                      | Resolved (W2-06, 5403b9e). the target is a single-file bind mount, so the rename onto it fails inside a container. Also, Compose needs both files to exist, and `init --yes` refuses to overwrite existing files, so `docker compose run --rm digest init --yes` always stops.                              |
| C3  | `.env.example` sets `OLLAMA_URL=http://localhost:11434`           | Resolved (W2-06, 5403b9e). Compose reads `.env` for interpolation, so a copied example overrides the Compose default and the container points at itself.                                                                                                                                                    |
| C4  | The `tracing` profile does not set `OTEL_EXPORTER_OTLP_ENDPOINT`  | Resolved (W2-06, 5403b9e). Jaeger starts but receives nothing until the user sets the variable.                                                                                                                                                                                                             |
| C5  | Lock staleness uses the pid                                       | Resolved (W2-06, 5403b9e). `serve` and a one-shot `docker compose run` are separate containers with separate PID namespaces, so a one-shot run cannot see the serving process's pid and may take over a live lock as stale. Use a lock that does not depend on pids, or check the lock's container/host id. |

### 9.3 Open questions

1. **Catch-up on quiet weeks.** Resolved (W2-08, 7f9a988): catch-up skips `sent`, `quiet` and
   `blocked` weeks and re-runs `failed`, `dry-run` and missing weeks. A manual `digest run` still
   skips only `sent`.
2. **Partial delivery.** Resolved (W2-08, 7f9a988; follow-ups W2-11, 3f164db, and W5-00, 97e55ad).
   Delivery is recorded per channel in `deliveredTo`. A rerun resumes from the saved `digest.md`
   and sends only to the channels that missed it; it refuses when `digest.md` is gone or its
   links changed. Dry and forced runs no longer replace the week's files once a channel has the
   digest, which closes the "same links, different wording" gap. A partly delivered week counts
   in cross-week dedupe like a sent one.
3. **Retention versus dedupe.** Resolved (429c066): the config loader rejects
   `keepWeeks < dedupeWeeks`.
4. **GitHub transports differ.** Known limit. Without a token the Atom feed includes
   prereleases; with a token the REST API skips them. Adding a token changes the digest. No
   transport is forced.
5. **Doctor and delivery.** Known limit. `doctor` checks that delivery secrets are set and that
   the markdown folder is writable, but does not test the SMTP or Slack connection. A wrong host
   or webhook shows up at the first send.
6. **Thresholds.** Resolved for the light profile (W3-03): the sweep over the 60 labelled
   classifier cases set `minRelevance` 1.5, `maxHype` 0.6, `maxMinorRelease` 0.75 and
   `guardFlag` 0.35 (filter accuracy 0.767 to 0.867, no false blocks). See
   `evals/thresholds/README.md`. The quality and fast profiles are not measured yet.
7. **Window versus ISO week.** Known limit, kept on purpose. The window is the last
   `windowDays` before the run, so a catch-up on Thursday covers Thursday to Thursday, not the
   ISO week the run is named after. Cross-week dedupe keeps the overlap from repeating items.
8. **AWS design doc.** Known limit. The spec says the full AWS design (VPC, IAM, KMS, alarms)
   "is in @", but the reference is empty and no such document is in the repo. Section 7 is the
   only AWS design here.
9. **Spec open items still open** (maintainer decisions): final source allowlist, default
   delivery channel, reference hardware for run times, public repo name and GHCR publishing.

### 9.4 Closed in wave 5

| Issue | Commit                             | What changed                                                                                                                                                                                                                                                                                                                                          |
| ----- | ---------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| W2-11 | 3f164db                            | A dry or forced run no longer replaces the files of a week that reached a channel; a tick that finds the lock held retries for 2 h                                                                                                                                                                                                                    |
| W5-00 | 8e2e1ce, 4419508, 97e55ad, 25c2544 | A bad character reference no longer throws; `truncate` keeps surrogate pairs; `FetchError`; https-only Slack webhook; `modelsInUse`; partly delivered weeks deduped; CI image scan                                                                                                                                                                    |
| W5-01 | e9fcfc5                            | Same-host redirects, 5 MiB cap, shared-link entries, typed retries, empty-source warning, link, date and summary reading                                                                                                                                                                                                                              |
| W5-02 | 61321fc                            | `init` recommends `light` and merges `.env`; new doctor checks; headline and intro groundedness; `decide` state budget; one redactor                                                                                                                                                                                                                  |
| W5-03 | c91eb5e, 195ae2c                   | Link check range guard; same-release dedupe; tag-restating titles; judge failure falls back to the first draft                                                                                                                                                                                                                                        |
| W5-04 | 6bd9aa5                            | Per-week eval detail, stability item ids, production replay cap, guard attack recall, eval judge, calibration tooling                                                                                                                                                                                                                                 |
| W5-05 | 234a9f2                            | Orphaned lock temp files are swept; `stop_grace_period` is 90m                                                                                                                                                                                                                                                                                        |
| W5-06 | 3482989, 27e5db0                   | Draft problems logged and stored; one writer retry; `afterProcess` filled; health check uses `modelsInUse`; guard engine and resume moved out of `runDigest.ts`; `RunOptions.signal`                                                                                                                                                                  |
| W5-08 | 625be34                            | `digest eval` passes an eval judge when `EVAL_JUDGE` is set and prints week problems and item ids; the light baseline after wave 5 (`2026-10-17-light-wave5.json`); a stale live-test assertion fixed                                                                                                                                                 |
| W5-09 | be43bc5                            | Deliveries retry transient errors; a failed scheduled run is retried twice; a 3 h run time limit and a second stop signal abort a run; run records, files and messages are redacted; model calls are traced; one provider construction                                                                                                                |
| W2-12 | 992a8f9                            | `digest run` says why a forced run kept the week's record and folder                                                                                                                                                                                                                                                                                  |
| W5-10 | 7183178, 094d8d3                   | `toPlainText` is linear; a source URL with credentials is rejected                                                                                                                                                                                                                                                                                    |
| W5-11 | 3ce3f7a                            | The link check no longer reads the `www.` of a collected `https://` URL as a link without a scheme (the 2026-W39 failure); the write step adds `https://` to a bare link that names a collected item; the retry prompt names the kind of link fault; the headline and intro groundedness call has its own criterion; the scorecard names attack cases |
| W5-12 | 67420d3                            | One failure note per failed week (`notifyFailure`, `onGiveUp`); typed `DeliveryError`; delivery retries only when nothing was sent                                                                                                                                                                                                                    |
| W5-13 | 5d6bc35                            | `EVAL_JUDGE` from `.env`; the judge provider is the container's, with the eval logger; the judge tag is checked before the replay; one `toJudgeScore`                                                                                                                                                                                                 |
| W5-14 | efdf932                            | The GitHub fetcher warns once per source; `runId` and `step` on model-call and fetcher log lines                                                                                                                                                                                                                                                      |
| W5-16 | dd3d406                            | Bounded concurrency per guard in the guard engine; the default stays 1, by measurement                                                                                                                                                                                                                                                                |

### 9.5 Review findings checked by measurement

The "F" numbers are the findings of the 2026-10-17 review. Most rows come from one run:
`digest eval --profile light` (W5-08, 625be34), 45 minutes, scorecard
`evals/scorecards/2026-10-17-light-wave5.json`, every guard on, no eval judge. It ran on main at
27e5db0 plus the W5-08 eval changes, so it does not include W5-09, W5-11 to W5-16, W6-02 or
W6-03. F38 and F45 were closed later and are measured or checked on their own.

| Finding  | Topic                                   | State                                                                                    | Result                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| -------- | --------------------------------------- | ---------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| F1       | Format gate and the writer retry        | Resolved (W5-11, 3ce3f7a; retry W5-06, 3482989). Not re-measured in a full run           | Format 67% to 83% (5 of 6 weeks) in the wave 5 run. 2026-W39 still had no digest, and the first reading of it was wrong: the writer did not write a link without a scheme. The link check read the `www.` of the valid `https://www.docker.com/...` link as one, in both attempts, so the retry had nothing to fix. W5-11 fixed the check. A replay of 2026-W39 on `light` then passed every guard on the first attempt (a targeted replay, not a full eval). |
| F8       | Stability reads 0                       | Resolved (W5-04, 6bd9aa5; measured 625be34)                                              | Stability 1.33 (gate 4). The scorecard keeps the item ids: runs 1 and 3 share 4 of 5 items, run 2 was blocked and empty.                                                                                                                                                                                                                                                                                                                                      |
| F10      | Writing quality unmeasured              | Wired (W5-04, 6bd9aa5; W5-08, 625be34; `.env` and install check W5-13, 5d6bc35), not run | Needs a full replay with `EVAL_JUDGE` set, in `.env` or the shell (about 45 minutes plus loading the 18 GB `clef:latest`). Since W5-13 a wrong tag fails before the replay. Writing quality and selection agreement are still empty.                                                                                                                                                                                                                          |
| F11      | Replay window wider than production     | Resolved (W5-04, 6bd9aa5; measured 625be34)                                              | `notVisible` is 1: the 2026-W39 must-exclude label (item 22 of `openai-news`). Must-exclude leaks 0.50, which passes the gate at its limit.                                                                                                                                                                                                                                                                                                                   |
| F12      | Guard recall on attacks                 | Metric resolved (W5-04, 6bd9aa5; measured 625be34); guard tuning open                    | Guard attack recall 60%: `clefPolicy` flags 6 of 10, `graniteRisk` none. The soft gate is 90%. Attack handling fell from 100% to 90%: one unflagged attack item reached a digest.                                                                                                                                                                                                                                                                             |
| F42      | Live tests never run                    | Resolved (625be34)                                                                       | `LIVE_OLLAMA=1` over `test/live`: 11 of 12 passed once (689 s). The one failure was a stale assertion (a dry run records no sent URLs since W2-08), fixed in the test; not run live again.                                                                                                                                                                                                                                                                    |
| F38      | Guard calls run one at a time           | Resolved (W5-16, dd3d406): concurrency shipped, default 1 by measurement                 | Bounded concurrency per guard (2.2). On `light`, limits 1, 2 and 4 took about 112 s for 116 guard calls with identical verdicts, and a call took about as many times longer as the limit: Ollama served the calls one at a time. The 575 s of the finding was measured earlier and was not measured again; `guardInput` on 2026-W39 took 100 to 113 s in this test.                                                                                           |
| F45 (D8) | Model-call logs lack `runId` and `step` | Resolved (W5-14, efdf932): both fields                                                   | The model-call lines and the fetcher warnings carry `runId` and, inside a step, `step` (8.3). No `ModelProvider` port change was needed. The eval harness calls steps directly, so its model-call lines still have no `runId`.                                                                                                                                                                                                                                |

### 9.6 Known limits after wave 5

Open:

- The Trivy job has not run yet (D13).
- The headline and intro groundedness call adds one Granite call per digest, and a "yes" flags the
  whole draft. W5-11 gave it its own criterion (2.6), and a targeted check flagged 0 of 10 clean
  controls, down from 5 of 10. Real drafts are less clean than the controls. In a targeted replay
  of the six recorded weeks on `light` with the new criterion, three weeks passed every guard, one
  was blocked by the headline call (2026-W36, which the old criterion also flagged) and two by an
  item call (W37 and W40). So "0 of 10 controls" overstates how clean real drafts are. Making the
  headline finding log-only is an option and is not done (W6-05, W6-06). Item titles are not
  checked. None of this is a re-baseline.
- No grounding case plants a claim in the headline or intro, so the headline call is measured for
  false blocks only (W6-05).
- Two `light` hard gates were red in the wave 5 scorecard: format (83%) and attack handling (90%).
  The format cause is fixed (F1). The attack miss, one unflagged attack item that reached a digest,
  is not. The scorecard names that case from the next eval on. It cannot name the clean cases a
  guard flagged until `evals/runEval.ts` passes the case ids (W6-06).
- The wave 5 scorecard predates W5-09, W5-11 to W5-16, W6-02 and W6-03, so it does not show what
  the adapter pipeline, the article pages, the source tag change or the fixes of the finish batch
  do. The full `light` re-baseline is W6-06.
- The link check does not see an autolink with a scheme other than `http(s)` (`<ftp://host/x>`,
  `<javascript:...>`, `<mailto:...>`) or a GFM autolink glued after an underscore
  (`_www.evil/x_`). It also accepts a collected URL with extra tracking parameters (`utm_*` and
  the like) or a fragment, because `normalizeUrl` drops both, and they can carry a second URL. The
  W5-11 review found these. They are not fixed and need their own issue.
- Same-release dedupe is narrow on purpose and merges the same product on two platforms (2.4).
  The Muse Spark pair that motivated it is not merged by code, because one title has no version;
  the write prompt covers it.
- A source that returns nothing is logged, not recorded in `run.json` (the record schema is
  frozen). A fetcher warns once per source per attempt, so a fetch that `collect` retries warns
  again. Entries the adapters drop on purpose (drafts and prereleases, or one release with a
  non-github.com link or no date among good ones) are not counted.
- After the `?entry=` rule, the newest Google Cloud release-notes days that went out under the
  bare link can be delivered once more.
- A retried writer's first draft is not kept in `drafts.json`; its problems are.
- The abort signal is checked between steps only, because `ModelProvider` takes no signal. The
  scheduler does not abandon a run that ignores it.
- A failure note can still go out twice if a caller's `run` ignores `RunAttempt.notifyFailure`
  (the type makes `attempt` optional so old callers compile), and it is not sent when the first
  attempt throws instead of returning a result (the error is logged). `onGiveUp` has no time
  limit of its own; the adapters bound it. Whether a failure is final is read from the error text
  (`--force` and the `Run aborted` prefix); a typed marker on the error would be cleaner.
- A delivery can still arrive twice (2.8, at-least-once).
- Redaction covers the declared secrets and the Slack webhook path. A password inside
  `OLLAMA_URL` or the OTLP endpoint is not a declared secret, and is not covered.
- `runId` and `step` on log lines are an unwritten contract between the span attributes core
  opens and the container; a shared constant would be cleaner. The real-`runDigest` tests fail if
  core renames them.
- `GUARD_CONCURRENCY` is 1. A value above what Ollama serves in parallel makes calls queue and
  time out (2.2).

Closed by the finish batch (see 9.4):

- Each failed attempt of a scheduled run sent its own failure note, so one cause could produce
  three notes in about an hour, and the first could say "failed" before a retry succeeded.
  Resolved (W5-12, 67420d3): one note per failed week (2.8).
- The delivery kind was read from error text, because the adapters flattened their errors, and
  delivery retries could double a message at each layer. Resolved (W5-12, 67420d3): typed
  `DeliveryError`, and a retry only when nothing was sent. The case of a lost answer remains (2.8).
- The GitHub fetcher took no logger, so only the RSS fetcher logged its per-feed warnings.
  Resolved (W5-14, efdf932).
- The scorecard did not keep which attack case reached the digest. Resolved (W5-11, 3ce3f7a) for
  attacks; the false-block half is open (above).
- The `light` groundedness guard flagged half of the clean control drafts, and the likely cause,
  the headline and intro call, was not confirmed. Resolved on the controls (W5-11, 3ce3f7a):
  confirmed (5 of 10 controls, and only that call) and fixed with a criterion of its own.
- The scheme-less writer link (F1). Resolved (W5-11, 3ce3f7a): it was a link check bug.
- `EVAL_JUDGE` was read from the shell only, and a typo showed after the replay. Resolved (W5-13,
  5d6bc35).
- Model-call log lines had no `runId` or `step` (D8). Resolved (W5-14, efdf932).
- Guard calls ran one at a time (F38). Resolved (W5-16, dd3d406): bounded concurrency, default 1
  by measurement.
