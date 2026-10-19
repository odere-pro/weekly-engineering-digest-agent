# Current results

Part of [Evaluation](README.md).

## The scorecard

- `evals/scorecards/2026-10-18-light.json`: profile `light`, 112.5 min, hard gates **FAIL** ([gates](gates.md)).
- Models: `strands-decider:2b-mlx-bf16` (classify, guardPolicy), `granite4.1-guardian:8b` (guardRisk),
  `gemma4:e4b-mlx` (write, one writer). Eval judge `clef:latest`, not calibrated.
- Cases: 6 weeks (2026-W36 to W41), 60 classifier, 20 attacks, 10 grounding, 24 sources. It predates
  wave 11: the next scorecard uses 31 attacks and 30 grounding drafts, and has 17 metrics, not 16. Wave 12 adds fact carry, the 18th.

## All metrics

| Metric                     | Value          | Gate                   | Result    | Note                           |
| -------------------------- | -------------- | ---------------------- | --------- | ------------------------------ |
| Link validity              | 100%           | hard, at least 100%    | pass      | W36 has no digest, not counted |
| Attack handling            | 100%           | hard, at least 100%    | pass      | 20 of 20 kept out              |
| Guard attack recall        | 100%           | soft, at least 90%     | pass      | clefPolicy 20, graniteRisk 0   |
| Groundedness               | 100%           | hard, at least 100%    | pass      | 10 of 10 caught                |
| Format                     | 83.3%          | hard, at least 100%    | **fail**  | W36 has no digest              |
| Fact carry                 | none yet       | soft, at least 100%    | not gated | no value in this scorecard     |
| Guard false blocks         | 1.7%           | soft, at most 5%       | pass      | worst guard: clefPolicy        |
| Guard blocks on real weeks | none yet       | soft, at most 5%       | not gated | no value in this scorecard     |
| Must-include recall        | 1.33 of 5      | soft, at least 3       | **fail**  | W36 counts as 0                |
| Must-exclude leaks         | 0.67 per week  | soft, at most 0.5      | **fail**  | 1 label not visible            |
| Classifier accuracy        | 28.3%          | soft, at least 80%     | **fail**  | area 68%, relevance 42%        |
| Writing quality            | 3.62 of 5      | soft, 3.5, needs judge | not gated | judge not calibrated           |
| Selection agreement        | not measured   | soft, 70%, needs judge | not gated | no calibration file            |
| Writer win rate            | 100%           | none                   | not gated | only one writer                |
| Stability                  | 1.67 of 5      | soft, at least 4       | **fail**  | first week; one blocked run    |
| Run time                   | 340 s per week | none                   | not gated | 208 s to 582 s                 |
| Source parse yield         | 100%           | soft, at least 95%     | pass      | 24 sources                     |
| Source summary fill        | 98.9%          | soft, at least 90%     | pass      | vllm-releases at 80%           |

## Metric by metric

### Link validity

100%. The five digests that were written and the attack replay linked only to collected items.

### Attack handling

100%. All 20 attack items stayed out of the digest. `clefPolicy` flagged all 20.

### Guard attack recall

100%. `clefPolicy` flagged 20 of 20; `graniteRisk` flagged 0 because mode `any` sends it only the rest.

### Groundedness

100%. `graniteGroundedness` rejected all 10 drafts with a planted false claim.

### Format

83.3% (5 of 6): 2026-W36 had no digest in its first replay (`no-digest`), so it fails.

### Fact carry

No value: the scorecard predates the metric (soft gate, at least 100%).

### Guard false blocks

1.7%, the worst guard (`clefPolicy`) on clean items. The other three guards flagged none.

### Guard blocks on real weeks

No value: the scorecard predates the metric (soft gate, at most 5%). 2 of 18 replays had no digest.

### Must-include recall

1.33 of 5 labeled items per week on average. 2026-W36 counts as 0 because it has no digest.

### Must-exclude leaks

0.67 per week. One labeled item (2026-W39) is outside the replay window and counts as neither.

### Classifier accuracy

28.3% on 60 cases, measured the old way: area and relevance within 0.5 both right (area 68%,
relevance 42%). The next scorecard counts a relevance within one point. The 2B light classifier is the ceiling.

### Writing quality

3.62 of 5, scored by `clef:latest` inside the harness. Reported, not gated: the judge is not calibrated.

### Selection agreement

Not measured. It comes from `judge/calibration.json`, which does not exist yet.

### Writer win rate

100% for `gemma4:e4b-mlx`, the only writer, so it always wins. Reported only.

### Stability

1.67 of 5 shared items: the mean overlap of three runs of 2026-W36, the first week. One run was
blocked. By week: 5.00 on W37, W38, W40 and W41; 1.67 on W36 and W39 (one blocked run each).

### Run time

340 s mean per plain replay (208 s on W36 to 582 s on W41), 2041 s in all.

### Source parse yield

100%. Every recording yielded its expected items (980 in all, 24 recordings).

### Source summary fill

98.9%. One source is below 90%: `vllm-releases` at 80%.

## Profiles

Only `light` is measured (2026-10-18, three of four hard gates pass). `fast` and `quality` are not.
Hardware: Apple M1 Pro, 32 GB, macOS, Ollama on the host, `OLLAMA_MAX_LOADED_MODELS=1`, all guards
on, seeded runs. Thresholds: `minRelevance` 1.5, `maxHype` 0.6, `maxMinorRelease` 0.75, `guardFlag`
0.35. Older: `2026-10-17-light.json`, `-light-wave5.json` (both failed a hard gate, 10 attacks).

## How to update this page

1. Get a new scorecard: [re-baseline the evals](../runbooks/maintain/re-baseline-evals.md). Replace
   the numbers, date and models above. Keep the headings: metric pages link to them.
2. Run `grep -rn "Current result" docs/evaluation/metrics`, update that line on each page and
   [status and limits](../overview/status-and-limits.md).
