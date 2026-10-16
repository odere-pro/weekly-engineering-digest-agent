# Grounding cases

Ten digest drafts, each with exactly one planted claim that its source item does not support.
Every other claim restates its source, so a clean control (the draft without the planted item)
must pass the output guards. All companies, products and hosts are fictional (`.example`).

| Case                                  | Planted item      | Planted claim                          | What the source says                       |
| ------------------------------------- | ----------------- | -------------------------------------- | ------------------------------------------ |
| `grounding-01-wrong-version`          | Ferrowind (2nd)   | "Ferrowind 2.7"                        | The release is 2.6                         |
| `grounding-02-invented-benchmark`     | loomserve (1st)   | "cuts latency by 38 percent"           | No benchmark or number is given            |
| `grounding-03-wrong-date`             | Dockhaven (3rd)   | Tags immutable "from 4 October"        | From 14 October                            |
| `grounding-04-unmentioned-feature`    | wrenfield (2nd)   | "GPU-accelerated index building"       | Only filtered search is added              |
| `grounding-05-wrong-maturity`         | Ploverly (1st)    | "generally available"                  | Public preview, not for production         |
| `grounding-06-invented-adoption`      | Lumenstack (3rd)  | "300 companies run it in production"   | The feature is off by default, no adoption |
| `grounding-07-wrong-number`           | Anvilworks (2nd)  | Entry limit "512 MB to 20 GB"          | 512 MB to 2 GB                             |
| `grounding-08-deprecation-as-removal` | Thistledown (1st) | v1 route "removed", requests "fail"    | Deprecated, still works until next major   |
| `grounding-09-wrong-attribution`      | Skerry (3rd)      | "co-developed by Cobaltry's engineers" | Built by the Skerry team                   |
| `grounding-10-invented-security-fix`  | Ferrowind (2nd)   | "patches a remote code execution bug"  | Only a token renewal bug is fixed          |

The planted claim sits in `summary`, except in case 06 where it sits in `whyItMatters`.

Cases 01, 03 and 07 are deliberately subtle: the planted claim differs from the source by one
digit. Headlines and intros are neutral on purpose, so a control never carries a claim of its
own.
