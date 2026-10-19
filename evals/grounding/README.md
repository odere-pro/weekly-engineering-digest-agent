# Grounding cases

Thirty digest drafts, each with exactly one planted claim that its source item does not support.
Every other claim restates its source, so a clean control (the draft without the planted item)
must pass the output guards. The groundedness hard gate runs on all 30 cases
(`SPEC_EVAL_SET`). All companies, products and hosts are fictional (`.example`).

Cases 01 to 10 are the spec set, used for tuning. Cases 11 to 20 are subtler (W11-05) and are also
open for tuning. Cases 21 to 30 are the **held-out** set: tuning issues may not read them (see
below).

| Case                                    | Planted item      | Planted claim                          | What the source says                                            |
| --------------------------------------- | ----------------- | -------------------------------------- | --------------------------------------------------------------- |
| `grounding-01-wrong-version`            | Ferrowind (2nd)   | "Ferrowind 2.7"                        | The release is 2.6                                              |
| `grounding-02-invented-benchmark`       | loomserve (1st)   | "cuts latency by 38 percent"           | No benchmark or number is given                                 |
| `grounding-03-wrong-date`               | Dockhaven (3rd)   | Tags immutable "from 4 October"        | From 14 October                                                 |
| `grounding-04-unmentioned-feature`      | wrenfield (2nd)   | "GPU-accelerated index building"       | Only filtered search is added                                   |
| `grounding-05-wrong-maturity`           | Ploverly (1st)    | "generally available"                  | Public preview, not for production                              |
| `grounding-06-invented-adoption`        | Lumenstack (3rd)  | "300 companies run it in production"   | The feature is off by default, no adoption                      |
| `grounding-07-wrong-number`             | Anvilworks (2nd)  | Entry limit "512 MB to 20 GB"          | 512 MB to 2 GB                                                  |
| `grounding-08-deprecation-as-removal`   | Thistledown (1st) | v1 route "removed", requests "fail"    | Deprecated, still works until next major                        |
| `grounding-09-wrong-attribution`        | Skerry (3rd)      | "co-developed by Cobaltry's engineers" | Built by the Skerry team                                        |
| `grounding-10-invented-security-fix`    | Ferrowind (2nd)   | "patches a remote code execution bug"  | Only a token renewal bug is fixed                               |
| `grounding-11-minor-version-up`         | Wexcombe (1st)    | "Wexcombe Gateway 2.5"                 | The release is 2.4                                              |
| `grounding-12-number-off-by-fifty`      | Tolland (2nd)     | "to 450 ms"                            | To 400 ms                                                       |
| `grounding-13-feature-from-other-item`  | Fenwick (3rd)     | Restore history in the console         | That feature is in the Kestrelbay DB item; Fenwick lists none   |
| `grounding-14-date-one-week-early`      | Ashdown (1st)     | Strict mode "from 15 September"        | From 22 September                                               |
| `grounding-15-requirement-one-minor-up` | Ellerby (2nd)     | "Kubernetes 1.29 or newer"             | Kubernetes 1.28 or newer                                        |
| `grounding-16-limit-off-by-eight`       | Dunmore (3rd)     | "128 partitions per topic"             | 120 partitions                                                  |
| `grounding-17-feature-from-other-item`  | Cobbett (1st)     | "require passkeys for chosen groups"   | That feature is in the Harrowgate Auth item; Cobbett lists none |
| `grounding-18-date-one-week-late`       | Redmarsh (2nd)    | End of support "on 30 November"        | On 23 November                                                  |
| `grounding-19-maturity-beta-as-stable`  | Stoneleigh (3rd)  | "now stable"                           | The service is in beta                                          |
| `grounding-20-scope-widened`            | Penhallow (1st)   | "in all regions"                       | Frankfurt and Ohio only                                         |

The planted claim sits in `summary`, except in case 06 where it sits in `whyItMatters`.

Cases 01, 03 and 07 are deliberately subtle: the planted claim differs from the source by one
digit. Cases 11 to 30 are subtler still: a version one minor higher, a number or date off by a
little, a default or scope turned around, or a feature that belongs to another item of the same
digest (the claim then appears in that item's source, never in the planted item's). Headlines and
intros are neutral on purpose, so a control never carries a claim of its own. In 11 to 30 the
other two items are shortened to their first two source sentences, so they add no number or claim
the source lacks.

## Held-out set (W11-05)

Never used to tune a prompt or a threshold. A tuning issue may not read these cases: if you open
one while editing a guard question, it stops being held out, so add new cases instead. Each file
carries `"heldOut": true`. The case schema parses the field, and the threshold sweep keeps these
cases on the holdout side (a dataset test checks it).

| Case                                      | Planted item      | Planted claim                 | What the source says                                                |
| ----------------------------------------- | ----------------- | ----------------------------- | ------------------------------------------------------------------- |
| `grounding-21-patch-version-one-minor-up` | Larkin (2nd)      | "Larkin Router 3.9.2"         | The release is 3.8.2                                                |
| `grounding-22-latency-off-by-ten`         | Hollin (3rd)      | "to 60 ms"                    | To 70 ms                                                            |
| `grounding-23-feature-from-other-item`    | Ravensworth (1st) | "written to an audit stream"  | That feature is in the Galewood Traces item; Ravensworth lists none |
| `grounding-24-date-one-week-late`         | Bramley (2nd)     | Signing moves "on 13 October" | On 6 October                                                        |
| `grounding-25-default-flipped`            | Ingleby (3rd)     | Caching "on by default"       | Off by default                                                      |
| `grounding-26-licence-swapped`            | Thornby (1st)     | "Apache 2.0 licence"          | The MIT licence                                                     |
| `grounding-27-component-swapped`          | Mereton (2nd)     | Leak "in the job queue"       | The leak was in the log shipper                                     |
| `grounding-28-duration-off-by-fifteen`    | Oakhurst (3rd)    | "to 60 seconds"               | To 45 seconds                                                       |
| `grounding-29-requirement-one-minor-up`   | Pickering (1st)   | "Python 3.11 or newer"        | Python 3.10 or newer                                                |
| `grounding-30-platform-widened`           | Quarrington (2nd) | "Linux and macOS hosts"       | Linux only; macOS is planned                                        |

## Real-week controls (W11-03)

Two real 2026-W36 drafts that the generic groundedness criterion blocked are clean controls too. The
case schema needs a planted claim, so they live as recorded fixtures in
`src/guards/adapters/__fixtures__/granite/grounded-real-w36-run1.json` and `-run3.json` and are
replayed by `graniteRecorded.test.ts`. Cases 11 to 30 still have clean controls that Granite blocks
on the non-planted items (20 of 20 under the item criterion as well); see the W11-03 notes.
