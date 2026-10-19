# Running in the cloud (proposal)

Part of [Operations](README.md).

**Nothing here is built.** This is a proposal for AWS, with prices read on 2026-10-17 for
us-east-1. The full runbook and spec are archived outside the repo. A figure marked
**estimate** was not read from a source.

## Should you move?

One reader on one Mac needs nothing here: the digest is free. Consider the cloud when:

- several people must get the mail, and a missed week affects them all;
- the machine must always be on (a Mac sleeps, travels, reboots);
- there is no Apple silicon Mac. Elsewhere every profile falls back to untuned models
  ([profiles](../configuration/profiles.md)).

If none applies, stay local.

## Three options

Costs are per month, one run a week, 10 recipients. Fargate task of 1 vCPU and 2 GB, public
subnet, no NAT gateway (a NAT gateway alone costs about $36).

| Question                               | A: Fargate + GPU EC2                                  | B: Fargate + Bedrock                        | C: local + S3 and SES                              |
| -------------------------------------- | ----------------------------------------------------- | ------------------------------------------- | -------------------------------------------------- |
| What runs where                        | Task starts a `g5.xlarge` with Ollama, runs, stops it | Task calls Bedrock models instead of Ollama | Mac as today; `dist/` synced to S3; SES sends mail |
| Monthly cost                           | about $19                                             | about $3.50                                 | about $1                                           |
| Same models and scores as the fallback | yes                                                   | no                                          | yes (Mac profiles)                                 |
| Code to write                          | a start/stop wrapper                                  | new provider, guards, root                  | none                                               |
| Evals to rerun                         | fallback profile                                      | everything                                  | none                                               |
| Works when the Mac is off              | yes                                                   | yes                                         | no                                                 |
| Biggest unknown                        | GPU run time                                          | decision quality of emulated guards         | Mac availability                                   |

Cost of option A (assumes a 2 h run; run time on a GPU is not measured):

| Line                                       | USD / month |
| ------------------------------------------ | ----------: |
| `g5.xlarge` on demand, 8.66 h              |        8.71 |
| EBS gp3, 100 GB                            |        8.00 |
| Fargate, 9.4 h                             |        0.46 |
| Public IPv4, task and instance             |        0.09 |
| Secrets Manager, KMS, ECR                  |        1.43 |
| EFS, 1 GB (removed once state moves to S3) |        0.30 |
| **Total**                                  |   **18.99** |

A run that stays on instead of stopping costs about $734 a month, so the plan has a backstop
stop schedule.

## Recommendation

Do **A**, in phases, and keep **C** as the zero-code stopgap while it is built. B saves about
$15 a month, which is less than an hour of engineering, and costs a rewrite of the guard layer
with unmeasured quality. Stay on C if the team is under about 5 people and the Mac is on most
days. Drop A for `g6e.xlarge` or C if one run takes more than about 4 hours.

## Phases

Each phase ends in a measurement. The next one does not start until the maintainer has read it.

| Phase | What                                                                               | Exit gate                                                                                                                              |
| ----- | ---------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| 0     | Hand-run: image on Fargate, Ollama on the GPU instance, config in S3, state on EFS | A dry run and a real run exit 0 from the schedule; `digest eval` on the fallback profile passes all four hard gates; run time recorded |
| 1     | Small changes to frozen files: a `linux` profile, env keys, an S3 SDK dependency   | `pnpm check` green with the new keys unset                                                                                             |
| 2     | S3 run store with a conditional-put lock, `doctor` checks for it                   | Contract tests green for both stores; two tasks started together: one runs, one exits 1                                                |
| 3     | Tune thresholds on the target                                                      | Four hard gates at 100% on the instance                                                                                                |
| 4     | Unattended: Step Functions power control, DLQ, failure alarm                       | Four scheduled weeks with exit 0, 2 or 3 only; the instance is stopped within 15 minutes of each run; monthly cost at most $28.50      |
| 5     | Cutover: recipients move to SES, the Mac scheduler is disabled                     | One week of mail with zero bounces                                                                                                     |

Rollback at every phase: delete the schedule and re-enable the Mac scheduler. State lives in a
versioned S3 bucket, so nothing is lost.

## Security rules for any cloud run

- Secrets only in Secrets Manager. Config (and so recipients) in S3, read-only for the task.
- Task role limited to the state prefix and one KMS key. No EC2, Bedrock or SES API access.
- Ollama port 11434 open only from the task's security group. Ollama has no authentication.
- The link check and the format check stay on. Nothing in this plan disables them.

## Open decisions

| #   | Decision                                                       | Recommended answer                                                  |
| --- | -------------------------------------------------------------- | ------------------------------------------------------------------- |
| 1   | Approve everything, or phase 0 first                           | Phase 0 only (no code), then the rest after its gate                |
| 2   | `linux` profile as a new name, or the existing fallback        | A new name, so `doctor` and evals say what they ran                 |
| 3   | Power control: Step Functions, shell wrapper, or two schedules | Step Functions, plus a fixed-time stop as a backstop                |
| 4   | Infrastructure tool                                            | CloudFormation YAML (no new tool); Terraform or CDK if already used |
| 5   | Where `feedback` runs                                          | On the laptop only                                                  |
| 6   | Account                                                        | A new account with a $30 budget alarm before anything is created    |
| 7   | Public IPv4 on the Ollama instance after setup                 | Remove it; decide how to update it before phase 4                   |
| 8   | Run-time cap that stops the plan                               | 4 hours                                                             |
| 9   | Region                                                         | us-east-1, as priced                                                |
