# AWS migration spec

Status: proposed. Not approved. Do not implement.

This is the engineering spec for [`aws.md`](aws.md). That page decides whether and how to run on
AWS and holds the hand-run phase 0 runbook. This page lists what changes in the code, in what
order, behind which flags, and how each phase is proven. It does not repeat the cost or option
analysis.

**Approval.** Nothing here may be built until the maintainer approves this spec in person. Each
implementation issue then names that approval in its frontmatter (`approval: maintainer, <date>`).

**Dates.** Code claims were checked against `main` at `8efb05d` on 2026-10-17. AWS prices and
limits come from `aws.md`, which read them on **2026-10-17**. This spec made no AWS calls and did
not re-read AWS pages. An AWS fact that `aws.md` did not read is marked **estimate**.

## 1. Scope

**In.** Option A of `aws.md` section 3, in its staged form: an EventBridge schedule starts the
existing image on Fargate (1 vCPU, 2 GB, us-east-1, public subnet, no NAT). Ollama runs on a
`g5.xlarge` that is stopped between runs. Run state moves from a local folder to S3. Secrets live in
Secrets Manager, config in S3, logs in CloudWatch.

**Stays local and unchanged.**

- Every pipeline step, prompt, guard, schema and the `ModelProvider`, `Guard`, `SourceFetcher` and
  `Delivery` ports.
- The Mac profiles `quality`, `fast` and `light`. The Mac remains a valid target and the rollback.
- Option C (local plus S3 and SES) stays the stopgap while this is built.
- `digest eval`, `feedback`, `history` and `init` work on a laptop as today.

**Out.** Bedrock (option B), multi-tenant, a web UI, Lambda, NAT, SageMaker (`aws.md` section 6).

## 2. Code changes

"Frozen" means the file is blocked for workers on any branch but `main`
(`.claude/rules/parallel-work.md`), so the coordinator changes it. Every flag defaults to off; with
all flags unset the program behaves as on `main`.

| #   | Change                                                                                                                                                                                               | File or module                                                                            | Port                                | Flag                          | Frozen file                                |
| --- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------- | ----------------------------------- | ----------------------------- | ------------------------------------------ |
| 1   | `linux` profile: x86 Linux tags, `requiresAppleSilicon: false`, own `minOllamaVersion`. Starts as a copy of `NON_MAC_FALLBACK` and is tuned in phase 3.                                              | `src/config/profiles.ts`, `ProfileNameSchema` in `src/config/schema.ts`                   | none                                | `profile: "linux"` in config  | **yes** (both)                             |
| 2   | Env keys: `DIGEST_STORE` (`fs` default, `s3`), `DIGEST_S3_BUCKET`, `DIGEST_S3_PREFIX`, `OLLAMA_READY_TIMEOUT_MS` (default 0). Cross-key rule: `s3` needs a bucket.                                   | `EnvSchema` in `src/config/schema.ts`                                                     | none                                | the keys themselves           | **yes**                                    |
| 3   | Remote Ollama wait: before `runDigest`, poll `model.health()` until `reachable` or the timeout; fail with exit 1 and a message naming `OLLAMA_URL`. Skipped when the value is 0.                     | `src/cli/run.ts` (or a helper in `src/cli/`)                                              | `ModelProvider.health()`, unchanged | `OLLAMA_READY_TIMEOUT_MS` > 0 | no                                         |
| 4   | S3 `RunStore`: same layout as `fsRunStore` (`<prefix>/runs/<week>/<artifact>`, `run.json`). Injected S3 client, no network in tests.                                                                 | new `src/adapters/store/s3RunStore.ts` (+ small helper files)                             | `RunStore` unchanged                | `DIGEST_STORE=s3`             | no                                         |
| 5   | Lock as a conditional put. See section 2.1.                                                                                                                                                          | new `src/adapters/store/s3RunLock.ts`; staleness rules shared with `runLock.ts` (see 2.1) | `RunLock` unchanged                 | `DIGEST_STORE=s3`             | no                                         |
| 6   | Store factory: one `createRunStore(loaded)` picks `fs` or `s3`. `history` and `feedback` call `createFsRunStore` directly today (`src/cli/history.ts:47`, `src/cli/feedback.ts:56`) and must use it. | `src/app/container.ts`, `src/cli/history.ts`, `src/cli/feedback.ts`                       | none                                | `DIGEST_STORE`                | no                                         |
| 7   | `doctor` store checks. See section 2.2.                                                                                                                                                              | `src/cli/doctor.ts`                                                                       | none                                | runs when `DIGEST_STORE=s3`   | no                                         |
| 8   | `AWS SDK` dependency for S3 only (`@aws-sdk/client-s3`). Needed by row 4. Credentials come from the task role, never from `.env`.                                                                    | `package.json`, `pnpm-lock.yaml`                                                          | none                                | none                          | **yes**                                    |
| 9   | Deploy files: IaC for the stack of `aws.md` section 5, the power-control state machine (2.3), IAM policies, a task definition template. Nothing in `src/`.                                           | new `deploy/**`                                                                           | none                                | none (not read by the app)    | no (`deploy/**` is not on the frozen list) |
| 10  | Dockerfile unchanged. It already has `USER node`, a pinned base and `/app/data` as a mount point; the S3 store does not need the mount, so the image stays the same on all targets.                  | none                                                                                      | none                                | none                          | no                                         |

Checked against `main`:

- `RunStore` is in `src/ports/RunStore.ts` and has nine methods. The S3 store implements them all.
  No port row needs a change.
- `fsRunStore` puts the lock at `<dataDir>/digest.lock` and runs at `<dataDir>/runs/<week>/`
  (`src/adapters/store/fsRunStore.ts`).
- `container.ts` builds the store in one place, `createFsRunStore({ dataDir: config.dataDir, ... })`
  (`src/app/container.ts`). Only `history` and `feedback` bypass it.
- `feedback` also writes under `<dataDir>/feedback` with plain `fs`. That folder is human input on a
  laptop and stays local (open decision 6).
- `DIGEST_HOST_OS` and `DIGEST_HOST_ARCH` already exist in `EnvSchema` and `resolveHostPlatform`
  (`src/config/load.ts:60`). Phase 0 uses them; row 1 does not remove them.
- `doctor` already checks `ollama` reachability and version (`checkOllama` in `src/cli/doctor.ts`)
  and a writable `dataDir`. Row 7 adds to this; row 3 reuses the same `health()`.
- The feed allowlist and the link and format checks live in `src/core` and `src/adapters/sources`.
  This spec changes none of them.

### 2.1 The lock as a conditional put

Today `acquireRunLock` creates the lock with a hard link, so it needs a file system that supports
`link`, and it takes over a stale lock under a second "guard" file (`src/adapters/store/runLock.ts`).
S3 gives a simpler compare-and-swap, so the S3 lock needs no guard file.

| Step               | S3 call                                                                                               |
| ------------------ | ----------------------------------------------------------------------------------------------------- |
| Acquire            | `PutObject` of `<prefix>/digest.lock` with `If-None-Match: *`. A `412` means a lock exists.           |
| Inspect            | `GetObject`; parse the same JSON (`pid`, `runId`, `startedAt`, `hostname`, `token`, `heartbeatAt`).   |
| Heartbeat (60 s)   | `PutObject` with `If-Match: <our ETag>`. A `412` means we lost the lock: stop beating, log a warning. |
| Take over if stale | `PutObject` with `If-Match: <stale ETag>`. Exactly one contender wins; the rest get `412`.            |
| Release            | `DeleteObject`, only after a `GetObject` shows the lock is still ours.                                |

The conditional-write semantics (`If-None-Match`, `If-Match` on writes) are from the S3 user guide
that `aws.md` read on 2026-10-17. Whether `DeleteObject` accepts a condition is **estimate**; the
design does not rely on it. Release is check-then-delete, as in `fsRunStore`, and keeps the same
small window (documented in `runLock.ts`).

Rules kept from the file lock:

- The stale test is the one in `staleReason`: heartbeat older than `LOCK_HEARTBEAT_TIMEOUT_MS`
  (5 minutes). The pid test does not apply across tasks because each Fargate task has its own host
  name; the heartbeat decides. Extract the pure staleness rules so both locks share them. The
  extraction is a refactor of `runLock.ts` and needs its tests to stay green unchanged.
- Clocks: a heartbeat is compared with the reader's clock, as today. Fargate tasks use AWS time
  sync (**estimate**: not read). A skew above one minute is far below the 5-minute timeout.
- One schedule, one task. The lock is the safety net, not the plan.

A new `RunStore` contract test (acquire, contention, heartbeat loss, takeover race, release) runs
against both stores. The S3 run uses a fake S3 client that implements `ETag` and the two
conditions.

### 2.2 `doctor` store checks

When `DIGEST_STORE=s3`, `doctor` replaces the `dataDir` check with these. Each reports `ok`, `warn`
or `fail` with a fix line, like the existing checks.

| Check              | How                                                                        | Fail means                                         |
| ------------------ | -------------------------------------------------------------------------- | -------------------------------------------------- |
| Bucket reachable   | `HeadBucket`                                                               | wrong name, region or role                         |
| Prefix writable    | write, read and delete one object under `<prefix>/doctor/`                 | role cannot write the prefix                       |
| Conditional writes | a second `If-None-Match: *` write to the same key must return `412`        | store ignores conditions; the lock would be unsafe |
| Lock state         | read `digest.lock`; `warn` if held, name the holder; `ok` if free or stale | a run is live or a stale lock will be taken over   |
| Versioning         | `GetBucketVersioning`; `warn` if off                                       | an overwritten `run.json` cannot be recovered      |

`doctor` needs `s3:GetBucketVersioning` and `s3:ListBucket`. Give them to the task role only if the
maintainer wants `doctor` to run inside the task (open decision 7).

### 2.3 Power control for the Ollama instance

The instance must stop on every exit, including a crash (`aws.md` section 2.1). The app does not
touch EC2. The recommended design is an AWS Step Functions standard state machine, defined in
`deploy/`: start instance, wait for status OK, `ecs:runTask.sync`, then stop instance in both the
success and the catch branch. It needs no Lambda and no code in `src/`. The app only waits for the
Ollama port (row 3). A second, separate EventBridge schedule stops the instance a fixed time after
the run window as a backstop (Monday 12:00; **estimate**, match the measured run time). Step
Functions pricing was not read: **estimate** under $0.01 per month at about 20 transitions a week.

## 3. Phases

Each phase ends in a measurement. A phase does not start until the maintainer has read the previous
gate. Every phase below the first needs the maintainer's approval of this spec.

`aws.md` phase 0 keeps run state on EFS because no code exists yet. After row 4 lands, state moves
to S3 and EFS is deleted (saving the $0.30 line and a mount target and security group).

| Phase | What                                                                                                                                                             | Code     | Exit gate (measured)                                                                                                                                                                                                                                                                  |
| ----- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 0     | Hand-run `aws.md` section 5: image on Fargate, remote Ollama, config in S3, state on EFS.                                                                        | none     | (a) one `run --dry-run` and one real run end with exit 0 from the schedule; (b) `digest eval` on the existing fallback profile, run as a one-off task: the four hard gates (link validity, attack handling, groundedness, format) at 100%; (c) wall time per run recorded in minutes. |
| 1     | Frozen-file changes on `main`: rows 1, 2, 8.                                                                                                                     | main     | `pnpm check` green; with all new keys unset, the existing test suite passes with no test edited.                                                                                                                                                                                      |
| 2     | S3 store, lock, factory, wait, `doctor` checks: rows 3 to 7.                                                                                                     | worktree | Contract tests green for both stores; 80% coverage on each new file; one real run against a staging bucket; two tasks started within one minute: one finishes, the other exits 1 with "Another run is in progress"; `doctor` shows all store checks `ok`.                             |
| 3     | Tune the `linux` profile on the target: thresholds `guardFlag`, `minRelevance`, `maxHype`, `maxMinorRelease`; recalibrate the judge if a second writer is added. | config   | `digest eval` scorecard on the instance: four hard gates at 100%; every other metric no worse than the phase 0 scorecard; run time known. If a gate cannot reach 100%, stop and apply the "evidence" table in `aws.md` section 3.                                                     |
| 4     | Unattended: Step Functions power control, backstop stop schedule, DLQ and failure alarm (row 9).                                                                 | deploy   | Four consecutive scheduled weeks with exit 0, 2 or 3 only; after each, the instance state is `stopped` within 15 minutes of task exit; a forced failure (bad `OLLAMA_URL`) pages by email; month cost from Cost Explorer within 1.5 × the `aws.md` estimate ($19, so at most $28.50). |
| 5     | Cutover: recipients move to SES, the Mac scheduler is disabled.                                                                                                  | config   | One week of mail to all recipients with zero bounces in SES; the Mac `serve` is stopped and `docs/runbook.md` updated.                                                                                                                                                                |

## 4. Security

| Area                    | Rule                                                                                                                                                                                                                                                                                                         |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| IAM, task role          | `s3:GetObject` on `digest.config.json`. On the state prefix only: `s3:GetObject`, `s3:PutObject`, `s3:DeleteObject`. `s3:ListBucket` limited to the prefix by condition. `kms:Decrypt` and `kms:GenerateDataKey` on the one key. No EC2, no Secrets Manager, no SES API, no Bedrock.                         |
| IAM, exec role          | ECR pull on one repository, log write to one log group, `GetSecretValue` on one secret, `kms:Decrypt`. As in `aws.md` step 5.                                                                                                                                                                                |
| IAM, state machine role | `ec2:StartInstances`, `ec2:StopInstances`, `ec2:DescribeInstanceStatus` on the one instance ARN; `ecs:RunTask` on one task definition and cluster; `iam:PassRole` for the two task roles; `events:*` for the `.sync` rule as AWS requires (**estimate**: confirm in the Step Functions docs before writing). |
| IAM, scheduler role     | Start the state machine only; send to the DLQ.                                                                                                                                                                                                                                                               |
| Secrets                 | `SMTP_PASSWORD`, `SLACK_WEBHOOK_URL`, `GITHUB_TOKEN` only in Secrets Manager, injected by the exec role as env vars. Never in config, the task definition text, S3 or logs. The app's redaction of `knownSecrets` stays on (`createRedactor` in `src/app/container.ts`).                                     |
| Checks                  | Link check and format check stay always on; no flag in this spec can disable them. `doctor` never prints a secret.                                                                                                                                                                                           |
| Recipients              | From the config file in S3 only. The task role cannot write that object, so a compromised task cannot change recipients. Model output never supplies a recipient or endpoint.                                                                                                                                |
| Ollama                  | Port 11434 open only from the task security group. Ollama has no authentication. The instance has no public IP in the target design if the task and instance share a VPC (**phase 0 gives it one for package install; remove it after**).                                                                    |
| Egress                  | Task security group: 443 out, plus 11434 to the Ollama group. The app enforces its own source host allowlist (`src/adapters/sources/http.ts`). A DNS-level egress filter needs a NAT or firewall and is out of scope (`aws.md` section 2.5).                                                                 |
| State bucket            | Block public access, KMS encryption, versioning on, a lifecycle rule that expires non-current versions after 90 days (**estimate**).                                                                                                                                                                         |
| Supply chain            | The base image is pinned by digest (`Dockerfile`). ECR scan on push stays on. One new runtime dependency (row 8), added only by the coordinator.                                                                                                                                                             |

## 5. Cost

From `aws.md` section 2.1, prices read 2026-10-17, us-east-1, one run a week of 2 hours
(**estimate**: run time is not measured).

| Line                                       |        USD / month | Note                                 |
| ------------------------------------------ | -----------------: | ------------------------------------ |
| g5.xlarge on-demand, 8.66 h                |               8.71 | $1.006/h from a third-party page     |
| EBS gp3, 100 GB                            |               8.00 | **unverified** rate                  |
| Fargate, 9.40 h                            |               0.46 |                                      |
| Public IPv4, task and instance             |               0.09 |                                      |
| Secrets Manager, KMS, ECR                  |               1.43 |                                      |
| EFS, 1 GB                                  |               0.30 | **removed** after phase 2            |
| S3 state, under 1 GB, under 1,000 requests |              ~0.05 | **estimate**: S3 rates were not read |
| Step Functions                             |              ~0.00 | **estimate**                         |
| **Total (phase 0 / after phase 2)**        | **18.99 / ~18.74** |                                      |

Gate for phase 4: at most 1.5 × $19 = $28.50. A run of 3 hours moves the total to about $23.4; a
run left on costs $734.38 a month, which is why the backstop stop schedule exists.

## 6. Rollback

State is in S3 with versioning on, so a rollback never loses it. The Mac needs the history only for
dedupe (`sentUrls`) and `history`.

| Phase | To return to local                                                                                                                                            |
| ----- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 0     | Delete the schedule (`aws.md` rollback). The Mac scheduler never stopped. Copy EFS `runs/` to the Mac if wanted (`aws s3 sync` from a one-off task).          |
| 1     | Revert the commit on `main`. All new keys default to off, so reverting needs no data change.                                                                  |
| 2     | Unset `DIGEST_STORE`. The program reads the local folder again. To keep history: `aws s3 sync s3://<bucket>/<prefix>/runs ./data/runs` (layout is identical). |
| 3     | Set `profile` back to `quality` on the Mac. Thresholds live in config, so keep one config file per target.                                                    |
| 4     | Disable the schedule and the state machine; stop the instance. Nothing else changes.                                                                          |
| 5     | Re-enable the Mac `serve`, point `delivery.email` back, run `digest history` to check dedupe sees the cloud weeks (it does after the sync above).             |

A stale `digest.lock` object left in S3 is removed by hand (`aws s3 rm`) or taken over after 5
minutes without a heartbeat.

## 7. Open decisions for the maintainer

| #   | Decision                                                                               | Recommended answer                                                                                                                                                         |
| --- | -------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Approve this spec as one decision, or approve phase 0 only first.                      | Approve phase 0 alone now (no code). Approve phases 1 to 5 after the phase 0 gate shows a run time and a passing scorecard.                                                |
| 2   | Is the `linux` profile a new name, or only the existing fallback with tuned config?    | A new name `linux`. Thresholds are config, but tags and `minOllamaVersion` are profile data, and a name makes `doctor` and evals say what they ran.                        |
| 3   | Store settings in `EnvSchema` or in the config file?                                   | `EnvSchema` (deployment, not editorial). Recipients and focus areas stay in the config file.                                                                               |
| 4   | Power control: Step Functions, a shell wrapper in the image, or two Scheduler entries. | Step Functions (no code, handles failure, stops on every exit), plus the fixed-time stop as a backstop.                                                                    |
| 5   | IaC tool for `deploy/`.                                                                | CloudFormation YAML: no new tool or repo dependency. Terraform or CDK only if you already use them.                                                                        |
| 6   | Where does `feedback` live on AWS?                                                     | Local only. It reads `review.md` through the store factory (row 6) and writes labels on the laptop, where the human works.                                                 |
| 7   | Should `doctor` run inside the task (needs `s3:GetBucketVersioning`, `s3:ListBucket`)? | No. Run it from the laptop with the same env against the bucket; keep the task role at the minimum.                                                                        |
| 8   | Who provisions the account: a new non-production account or an existing one?           | A new account in an AWS Organization, with a budget alarm at $30 per month before anything is created.                                                                     |
| 9   | Keep the public IPv4 on the Ollama instance after setup?                               | No. Install models, then remove it. This needs a way to reach it for updates (Session Manager through a VPC endpoint costs extra) or a rebuilt AMI. Decide before phase 4. |
| 10  | Cap on run time that stops the plan.                                                   | 4 hours, as in `aws.md` section 3. Above it, try `g6e.xlarge` or stay on option C.                                                                                         |
| 11  | Region.                                                                                | us-east-1, as priced. Change only for a data residency need; prices must then be re-read.                                                                                  |

## 8. Proposed issues

Not created. Each would be `approval: maintainer` and `status: proposed`. A frozen-file row is done
by the coordinator on `main`, so those issues run on `main` (`runs_on: main`).

| Title                                                              | `owns`                                                                                                            | `depends_on`   |
| ------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------- | -------------- |
| W8-01 AWS phase 0: run the runbook, record gates                   | `docs/aws-phase0-log.md` (lane `human`)                                                                           | W7-10          |
| W8-02 Frozen changes: `linux` profile, env keys, S3 SDK dependency | `src/config/profiles.ts`, `src/config/schema.ts`, `package.json`, `pnpm-lock.yaml`, their tests (`runs_on: main`) | W8-01          |
| W8-03 Share lock staleness rules                                   | `src/adapters/store/runLock.ts`, `src/adapters/store/lockRules.ts`, their tests                                   | W8-02          |
| W8-04 RunStore contract tests for both stores                      | `test/contracts/runStore.contract.ts`, `test/contracts/fakeS3.ts` (`test/fakes/` is frozen)                       | W8-02          |
| W8-05 S3 `RunStore` and conditional-put lock                       | `src/adapters/store/s3RunStore.ts`, `src/adapters/store/s3RunLock.ts`, their tests                                | W8-03, W8-04   |
| W8-06 Store factory, `history` and `feedback` use it               | `src/app/container.ts`, `src/cli/history.ts`, `src/cli/feedback.ts`, their tests                                  | W8-05          |
| W8-07 Remote Ollama wait in `run`                                  | `src/cli/run.ts`, its test                                                                                        | W8-02          |
| W8-08 `doctor` S3 store checks                                     | `src/cli/doctor.ts`, `src/cli/doctorStore.ts`, their tests                                                        | W8-05          |
| W8-09 Deploy stack and state machine                               | `deploy/**`                                                                                                       | W8-01          |
| W8-10 Tune the `linux` profile on the target                       | `docs/profiles.md`, `evals/**` scorecard output (lane `gpu`, `human`)                                             | W8-02, W8-09   |
| W8-11 Four-week unattended gate and cutover                        | `docs/runbook.md`, `docs/aws.md` status line (lane `human`)                                                       | W8-06 to W8-10 |
