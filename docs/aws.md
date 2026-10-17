# AWS: decision and phase 0 runbook

Status: proposal, nothing is built. Prices read on **2026-10-17**, region **us-east-1 (N. Virginia)**
unless a row says otherwise. Section 7 of [`system-design.md`](system-design.md) maps each local
component to an AWS service and compares Lambda with Fargate. This page does not repeat that. It
decides between three ways to run the digest, puts numbers on them, and gives the first step as
commands.

A claim marked **unverified** could not be read from the source on that date. Check it before you
spend money on it.

## 1. Why and when

The spec treats AWS as a later target for when a team, not one reader, needs the digest. Nothing in
the code needs AWS today: one reader on one Mac gets the digest for free.

What changes that:

- **Several recipients.** More than one person must get the mail, and a missed week now affects
  them all.
- **A machine that is always on.** The Mac sleeps, travels or gets rebooted; the scheduler's
  catch-up (see [`runbook.md`](runbook.md)) hides this but does not remove it.
- **No Mac.** The `quality`, `fast` and `light` profiles need Apple silicon
  (`requiresAppleSilicon` in `src/config/profiles.ts`). On Linux, `resolveProfile` falls back to
  `NON_MAC_FALLBACK`: one writer (`gemma4:31b`), `clef` for classify and guard policy,
  `granite4.1-guardian:8b` for risk, no judge. Its thresholds are untuned.

If none of these is true, stay local.

## 2. The three options

All cost figures are per month, one run per week. A month has 52 / 12 = 4.33 weeks. Fixed
assumptions in every option:

- Fargate task of **1 vCPU and 2 GB** (a valid Fargate size; the digest process is I/O-bound).
- Subnet design: the task runs in a **public subnet with a public IPv4 address** and a security
  group that allows outbound traffic only on 443 (feeds, GitHub, Slack, AWS APIs) plus the ports
  named per option. No NAT gateway. Reason: a NAT gateway alone costs more than any option below
  (see 2.5). The app already enforces its own host allowlist for feeds; what you lose is the
  DNS-level egress filter of section 7.1, which you can add later.
- One customer managed KMS key for everything (S3, EFS, Secrets Manager, SQS, SNS, logs).
- 10 recipients, one email each per week.

### 2.1 Option A: Fargate task plus Ollama on a GPU EC2 instance

**What runs where.** EventBridge Scheduler starts a Fargate task (the existing image, `run`
command). The task's first step starts a stopped `g5.xlarge` (1 NVIDIA A10G, 24 GiB GPU memory),
waits until Ollama answers on `OLLAMA_URL`, runs the digest, and stops the instance. Ollama and its
models (`gemma4:31b`, `clef:latest`, `granite4.1-guardian:8b`) live on the instance's EBS volume.
Task and instance share a VPC; port 11434 is open only from the task's security group (Ollama has no
authentication, so never expose it). `DIGEST_HOST_OS=linux`, `DIGEST_HOST_ARCH=x86_64` select the
Linux fallback profile.

**What code changes.** None for phase 0 if you start and stop the instance by hand or with a
Scheduler pair. Starting and stopping inside the run needs a small wrapper (a shell entrypoint or a
Step Functions state machine) around `node dist/cli.js run`; the wrapper must stop the instance on
every exit, including failures. The decide endpoint (`/v1/systemone`), `createOllamaProvider` and
the guards stay as they are.

**Evals to rerun.** `digest eval` on the fallback profile, which has no recorded baseline. The four
hard gates (link validity, attack handling, groundedness, format) must be 100%. Retune `guardFlag`,
`minRelevance`, `maxHype`, `maxMinorRelease` on the labelled cases, and recalibrate the judge
against the 10 hand-graded digests ([`profiles.md`](profiles.md)). The fallback profile has no
judge, so the single-writer path skips `select`.

**Cost.** Run time is not measured. The reference laptop needed about 59 minutes for 131 items on
the `quality` profile (see the comment in `docker-compose.yml`). I assume **2 hours** per run on
the A10G, including start-up and model load (one model fits at a time, so models swap), and a
2 h 10 min Fargate task. Treat this as the main uncertainty (see section 3).

| Line                              | Arithmetic                                                                  |       USD |
| --------------------------------- | --------------------------------------------------------------------------- | --------: |
| g5.xlarge on-demand               | 2 h × 4.33 = 8.66 h × $1.006/h                                              |      8.71 |
| EBS gp3, 100 GB                   | 100 GB × $0.08/GB-month (rate from an example on the pricing page)          |      8.00 |
| Fargate compute                   | 2.17 h × 4.33 = 9.40 h × (1 × $0.040478 + 2 × $0.004446) = 9.40 × $0.049370 |      0.46 |
| Public IPv4, task                 | 9.40 h × $0.005/h                                                           |      0.05 |
| Public IPv4, instance             | 8.66 h × $0.005/h                                                           |      0.04 |
| EFS (run history)                 | 1 GB × $0.30/GB-month (**unverified**)                                      |      0.30 |
| Secrets Manager                   | 1 secret × $0.40                                                            |      0.40 |
| KMS                               | 1 key × $1.00; requests inside the 20,000 free tier                         |      1.00 |
| ECR                               | 0.3 GB × $0.10/GB-month                                                     |      0.03 |
| SES                               | 10 × 4.33 = 43 mails × $0.10 / 1,000                                        |      0.00 |
| EventBridge, CloudWatch, SNS, SQS | inside free tiers (4 schedule invocations, < 5 GB logs)                     |      0.00 |
| **Total**                         |                                                                             | **18.99** |

If the instance were left running: 730 h × $1.006 = $734.38. If a run takes 1 h: instance $4.36,
total about $14.6. At 3 h: instance $13.07, total about $23.4. The EBS volume, not the GPU, is the
floor.

### 2.2 Option B: Fargate plus Bedrock adapters

**What runs where.** Fargate runs the digest. `BedrockModelProvider` calls Bedrock over the
internet endpoint (or a VPC endpoint, which costs extra). Writers: Gemma 4 31B and a second family
(Qwen3 Next 80B A3B) so the panel keeps two families. Classify and guard policy: Gemma 4 E2B with
`decide` emulated by one structured `generate` call per decision; the probabilities become 0/1 or
self-reported scores. Guards: Bedrock Guardrails content filters and prompt-attack filter stand in
for `clefPolicy` and `graniteRisk`; the contextual grounding check stands in for
`graniteGroundedness`; hype and off-task are emulated. The judge must be a family no writer uses
(Gemma and Qwen are taken, so it needs a third family, for example gpt-oss).

**What code changes.** A new `BedrockModelProvider`, an optional `BedrockGuardrailGuard`, a new
composition root, and frozen shared values on `main`: a new profile name and
`ModelProfile` fields that are not Ollama-only, a `GuardCheckId` choice, and vendor-neutral
health-check wording (section 7.4 of the design lists them). Phase 0 of this option is therefore a
`main` change before any worker can start.

**Evals to rerun.** All of A's, plus: every threshold, because emulated decisions are not
calibrated probabilities; the guard hard gates, because Guardrails has a different taxonomy from
granite's jailbreak and harm checks; and the judge calibration, because the judge model changes.

**Cost.** Token counts are estimated, not measured. Worst case at the spec's cap of 480 items per
run, per item three short calls (guard policy, classify, guard risk) of 1,500 input and 200 output
tokens, plus 110,000 input and 12,000 output tokens per run for writers, judge and output guards.
Run time assumed 1 hour (Bedrock latency, concurrency 1).

| Line                              | Arithmetic                                                    |      USD |
| --------------------------------- | ------------------------------------------------------------- | -------: |
| Small-model input (E2B)           | 480 × 3 × 1,500 = 2.16 M × 4.33 = 9.35 M tokens × $0.04/M     |     0.37 |
| Small-model output (E2B)          | 480 × 3 × 200 = 0.288 M × 4.33 = 1.25 M × $0.08/M             |     0.10 |
| Writer, judge, output guards, in  | 0.11 M × 4.33 = 0.48 M × $0.14/M (Gemma 4 31B)                |     0.07 |
| Writer, judge, output guards, out | 12,000 × 4.33 = 0.05 M × $0.40/M                              |     0.02 |
| Guardrails content filters        | about 1,500 text units per run × 4.33 = 6,500 × $0.15 / 1,000 |     0.98 |
| Fargate compute                   | 1 h × 4.33 = 4.33 h × $0.049370                               |     0.21 |
| Public IPv4, task                 | 4.33 h × $0.005/h                                             |     0.02 |
| EFS, Secrets Manager, KMS, ECR    | 0.30 + 0.40 + 1.00 + 0.03                                     |     1.73 |
| **Total**                         |                                                               | **3.50** |

Guardrails are priced per text unit and the unit count is a guess; the Qwen writer is not in the
table because the writer panel calls are the 110,000-token line above, priced at the Gemma rate
(Qwen3 Next is $0.15 in and $1.20 out per million, which adds under $0.05). If emulating `decide`
triples the tokens, add about $1.4.

### 2.3 Option C: stay local, add S3 and SES

**What runs where.** Everything runs on the Mac as today. `data/` is mirrored to S3 (`aws s3 sync`
after each run, as a launchd post-step or a cron on the Mac), so teammates and backups read the
digest from a bucket, and `delivery.email` points at the SES SMTP endpoint so one mail goes to the
whole team. This is the "team shares one Mac" path.

**What code changes.** None. The sync is a shell command; SES is `delivery.email` config plus a
`SMTP_PASSWORD` in `.env`.

**Evals to rerun.** None: models, thresholds and guards do not change.

| Line           | Arithmetic                                                                |      USD |
| -------------- | ------------------------------------------------------------------------- | -------: |
| S3 storage     | 0.1 GB × $0.023/GB-month (**unverified**; the pricing table did not load) |     0.00 |
| S3 requests    | under 100 requests/month, rates **unverified**                            |     0.00 |
| KMS (optional) | 1 key × $1.00; use SSE-S3 instead and this line is 0                      |     1.00 |
| SES            | 43 mails × $0.10 / 1,000                                                  |     0.00 |
| **Total**      |                                                                           | **1.00** |

The Mac's electricity and the risk that it is off are not in the table. That risk is the reason to
look at A or B.

### 2.4 Side by side

| Question                                   | A: Fargate + GPU EC2 | B: Fargate + Bedrock                  | C: local + S3, SES |
| ------------------------------------------ | -------------------- | ------------------------------------- | ------------------ |
| Monthly cost (assumptions above)           | about $19            | about $3.50                           | about $1           |
| Same models and scores as the Mac fallback | yes                  | no                                    | yes (Mac profiles) |
| Code to write                              | a start/stop wrapper | provider, guard, root, `main` changes | none               |
| Evals to rerun                             | fallback profile     | everything                            | none               |
| Works when the Mac is off                  | yes                  | yes                                   | no                 |
| Biggest unknown                            | GPU run time         | decision quality of emulation         | Mac availability   |

### 2.5 What a NAT gateway would cost

Private subnets need a NAT gateway for feed access. The VPC pricing page's example, **for
us-east-2 (Ohio)**, is $0.045 per hour and $0.045 per GB processed; the us-east-1 rate was not on
the page (**unverified**, expected equal). 730 h × $0.045 = $32.85, plus the gateway's public IPv4
730 h × $0.005 = $3.65, so **about $36.50 per month before any traffic**. That is more than A, B and
C each. Phase 0 avoids it. Add it only when a policy demands that tasks have no public address;
then also buy the interface endpoints (price **unverified**) or accept the traffic cost.

## 3. Recommendation

**Do A, in the staged form of section 5, and keep C as the zero-code stopgap while it is built.**

Reason. B is cheaper by about $15 a month, but that saving is smaller than one hour of engineering
and it buys a rewrite of the guard layer, an unmeasured quality drop (emulated decisions, a
different guard taxonomy, a new judge) and changes to frozen files on `main`. A keeps the code and
the `decide` endpoint unchanged, and the only new work is the first `digest eval` on a profile that
already exists. C is the right answer if the team can live with one Mac; it is a stopgap if the
team cannot.

Evidence that would change this:

| If one `digest eval` on the fallback profile shows…                                                                                    | Then…                                                                                                                      |
| -------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| a run time above about 4 h on the g5.xlarge, or model swaps dominating                                                                 | try `g6e.xlarge` (L40S, 48 GiB; $1.861/h on a third-party page, **unverified**) so all models stay loaded, or reconsider B |
| any hard gate under 100% on the fallback profile that threshold tuning fixes badly                                                     | B does not help (it is harder); stay on C and wait for a stronger Linux profile                                            |
| token counts (add token counting to the eval) under about 2 M in per run, and a Bedrock Gemma-class model passing the gates in a trial | B becomes viable; its monthly cost would be under $5                                                                       |
| the team is under about 5 people and the Mac is on most days                                                                           | stay on C                                                                                                                  |

## 4. Blockers and how each option treats them

| Blocker                              | A                                                                                                                                               | B                                                                                                                                                      | C                          |
| ------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------- |
| `decide()` has no Bedrock equivalent | not hit: Ollama's endpoint runs on the instance                                                                                                 | emulated with `generate`; retune thresholds                                                                                                            | not hit                    |
| MLX tags (`*-mlx`)                   | `fast`, `light` and `quality` cannot run; the Linux fallback uses `gemma4:31b`                                                                  | replaced by Bedrock model ids in a new profile                                                                                                         | not hit (stays on the Mac) |
| `strands-decider`                    | cannot run on Linux; `clef` does classify and guard policy                                                                                      | replaced by decide emulation                                                                                                                           | not hit                    |
| Thresholds differ across models      | retune once on the fallback profile (`digest eval`)                                                                                             | retune plus judge recalibration                                                                                                                        | none                       |
| File lock with one replica           | `fsRunStore` locks with hard links on EFS; a dead task's lock is taken over after the 5-minute heartbeat timeout. Keep the schedule at one task | needs the same EFS, or a DynamoDB or S3 conditional-write lock in a new `RunStore` (S3 supports `If-None-Match` and `If-Match` on writes, see sources) | not hit                    |
| Cold model load                      | adds minutes per start; budgeted in the 2 h                                                                                                     | none                                                                                                                                                   | none                       |

## 5. Phase 0 runbook

Goal: the existing image runs on Fargate once a week against a remote `OLLAMA_URL`, with config in
S3, secrets in Secrets Manager, logs in CloudWatch, one EventBridge schedule with a DLQ, and an
alarm on a failed exit code. No code change. This is the input for W7-10.

Do it in a non-production account, with an administrator profile. Nothing below has been run. Names
in `UPPER_CASE` are shell variables you set in step 0. Commands use AWS CLI v2.

**Run state.** The task has 20 GB of ephemeral storage that disappears on exit, so run history,
the lock and cross-week dedupe would reset every week. Mount an EFS file system on `/app/data` to
keep them (step 5). Sending still works without it.

### Step 0. Variables and prerequisites

```bash
export AWS_REGION=us-east-1
export ACCT=$(aws sts get-caller-identity --query Account --output text)
export APP=eng-digest
export BUCKET=$APP-config-$ACCT
export ECR_URI=$ACCT.dkr.ecr.$AWS_REGION.amazonaws.com/$APP
export OLLAMA_TYPE=g5.xlarge
```

Needs: Docker (buildx), AWS CLI v2, `jq`, a default VPC with a public subnet (console: VPC →
Your VPCs). Pick the subnet and note it:

```bash
export VPC=$(aws ec2 describe-vpcs --filters Name=isDefault,Values=true --query 'Vpcs[0].VpcId' --output text)
export SUBNET=$(aws ec2 describe-subnets --filters Name=vpc-id,Values=$VPC Name=default-for-az,Values=true --query 'Subnets[0].SubnetId' --output text)
```

### Step 1. KMS key

```bash
export KEY_ID=$(aws kms create-key --description "$APP" --query KeyMetadata.KeyId --output text)
aws kms create-alias --alias-name alias/$APP --target-key-id $KEY_ID
export KEY_ARN=arn:aws:kms:$AWS_REGION:$ACCT:key/$KEY_ID
```

One key serves S3, EFS, Secrets Manager, SQS and SNS. Console: KMS → Customer managed keys →
`alias/eng-digest` → Key policy. Add statements for the two task roles (step 4) and, for
CloudWatch Logs, the service principal `logs.us-east-1.amazonaws.com` with
`kms:Encrypt*`, `kms:Decrypt*`, `kms:GenerateDataKey*`, `kms:Describe*` and a condition on the log
group ARN (**unverified** policy shape; read the CloudWatch Logs KMS page first).

### Step 2. ECR and the image

```bash
aws ecr create-repository --repository-name $APP --image-scanning-configuration scanOnPush=true \
  --encryption-configuration encryptionType=KMS,kmsKey=$KEY_ARN
aws ecr get-login-password | docker login --username AWS --password-stdin $ACCT.dkr.ecr.$AWS_REGION.amazonaws.com
docker buildx build --platform linux/amd64 -t $ECR_URI:phase0 --push .
```

`--platform linux/amd64` matters when building on an Apple-silicon Mac, because Fargate runs the
x86 task definition below. Console: ECR → Repositories → eng-digest → image scan findings.

### Step 3. Config in S3 and secrets in Secrets Manager

```bash
aws s3api create-bucket --bucket $BUCKET
aws s3api put-public-access-block --bucket $BUCKET \
  --public-access-block-configuration BlockPublicAcls=true,IgnorePublicAcls=true,BlockPublicPolicy=true,RestrictPublicBuckets=true
aws s3api put-bucket-encryption --bucket $BUCKET --server-side-encryption-configuration \
  '{"Rules":[{"ApplyServerSideEncryptionByDefault":{"SSEAlgorithm":"aws:kms","KMSMasterKeyID":"'$KEY_ARN'"}}]}'
aws s3api put-bucket-versioning --bucket $BUCKET --versioning-configuration Status=Enabled
aws s3 cp digest.config.json s3://$BUCKET/digest.config.json
```

The config file is a copy of your `digest.config.json` with `"profile": "quality"` (the Linux
fallback is chosen by the host variables below) and the real `delivery` section. For email use the
SES SMTP endpoint (`email-smtp.us-east-1.amazonaws.com`, port 587; **unverified** here, read the
SES SMTP page) and verify the sender in SES first (console: SES → Verified identities).

```bash
aws secretsmanager create-secret --name $APP/env --kms-key-id $KEY_ARN \
  --secret-string '{"SMTP_PASSWORD":"…","SLACK_WEBHOOK_URL":"https://hooks.slack.com/…","GITHUB_TOKEN":"…"}'
export SECRET_ARN=$(aws secretsmanager describe-secret --secret-id $APP/env --query ARN --output text)
```

Remove keys you do not use; the schema allows each to be absent. Type the values yourself; do not
paste them into a shared terminal or a ticket.

### Step 4. Network, Ollama host, EFS

Security groups (console: EC2 → Security Groups):

```bash
export SG_TASK=$(aws ec2 create-security-group --group-name $APP-task --description task --vpc-id $VPC --query GroupId --output text)
export SG_OLLAMA=$(aws ec2 create-security-group --group-name $APP-ollama --description ollama --vpc-id $VPC --query GroupId --output text)
export SG_EFS=$(aws ec2 create-security-group --group-name $APP-efs --description efs --vpc-id $VPC --query GroupId --output text)
aws ec2 authorize-security-group-ingress --group-id $SG_OLLAMA --protocol tcp --port 11434 --source-group $SG_TASK
aws ec2 authorize-security-group-ingress --group-id $SG_EFS --protocol tcp --port 2049 --source-group $SG_TASK
```

New security groups allow all outbound traffic; for least privilege, delete that default rule on
`$SG_TASK` and add egress for 443 to `0.0.0.0/0`, 11434 to `$SG_OLLAMA` and 2049 to `$SG_EFS`
(console: Security group → Outbound rules → Edit).

Ollama host. Console: EC2 → Launch instance → name `eng-digest-ollama`, type `g5.xlarge`, an
AWS Deep Learning Base AMI with NVIDIA drivers (Amazon Linux 2023; **unverified** name, search
"Deep Learning Base" in AMI catalog), subnet `$SUBNET`, security group `$SG_OLLAMA`, 100 GB gp3
encrypted with `alias/eng-digest`, no key pair (use Session Manager). Then, in Session Manager:

```bash
curl -fsSL https://ollama.com/install.sh | sh
sudo systemctl edit ollama   # add: [Service] Environment="OLLAMA_HOST=0.0.0.0:11434" "OLLAMA_MAX_LOADED_MODELS=1"
sudo systemctl restart ollama
ollama pull gemma4:31b && ollama pull clef:latest && ollama pull granite4.1-guardian:8b
```

Then stop it (`aws ec2 stop-instances`) and record `OLLAMA_URL=http://<private-ip>:11434`. If a
tag does not pull, use the same source as on the Mac (`ollama list` shows the tags you have).

EFS:

```bash
export FS=$(aws efs create-file-system --encrypted --kms-key-id $KEY_ARN --tags Key=Name,Value=$APP --query FileSystemId --output text)
aws efs create-mount-target --file-system-id $FS --subnet-id $SUBNET --security-groups $SG_EFS
export AP=$(aws efs create-access-point --file-system-id $FS \
  --posix-user Uid=1000,Gid=1000 --root-directory 'Path=/data,CreationInfo={OwnerUid=1000,OwnerGid=1000,Permissions=750}' \
  --query AccessPointId --output text)
```

UID 1000 is the `node` user the image runs as (`USER node`, see `Dockerfile`).

### Step 5. IAM roles

Execution role (ECS pulls the image, writes logs, injects the secret):

```bash
cat > trust-ecs.json <<'JSON'
{"Version":"2012-10-17","Statement":[{"Effect":"Allow","Principal":{"Service":"ecs-tasks.amazonaws.com"},"Action":"sts:AssumeRole"}]}
JSON
aws iam create-role --role-name $APP-exec --assume-role-policy-document file://trust-ecs.json
aws iam put-role-policy --role-name $APP-exec --policy-name exec --policy-document "{
 \"Version\":\"2012-10-17\",\"Statement\":[
  {\"Sid\":\"Pull\",\"Effect\":\"Allow\",\"Action\":[\"ecr:BatchGetImage\",\"ecr:GetDownloadUrlForLayer\"],\"Resource\":\"arn:aws:ecr:$AWS_REGION:$ACCT:repository/$APP\"},
  {\"Sid\":\"EcrToken\",\"Effect\":\"Allow\",\"Action\":\"ecr:GetAuthorizationToken\",\"Resource\":\"*\"},
  {\"Sid\":\"Logs\",\"Effect\":\"Allow\",\"Action\":[\"logs:CreateLogStream\",\"logs:PutLogEvents\"],\"Resource\":\"arn:aws:logs:$AWS_REGION:$ACCT:log-group:/$APP:*\"},
  {\"Sid\":\"Secret\",\"Effect\":\"Allow\",\"Action\":\"secretsmanager:GetSecretValue\",\"Resource\":\"$SECRET_ARN\"},
  {\"Sid\":\"SecretKey\",\"Effect\":\"Allow\",\"Action\":\"kms:Decrypt\",\"Resource\":\"$KEY_ARN\"}]}"
```

Task role (what the running containers may do): read one config object and use the EFS access point.
It has no Bedrock, no SES API, no secret access:

```bash
aws iam create-role --role-name $APP-task --assume-role-policy-document file://trust-ecs.json
aws iam put-role-policy --role-name $APP-task --policy-name task --policy-document "{
 \"Version\":\"2012-10-17\",\"Statement\":[
  {\"Sid\":\"Config\",\"Effect\":\"Allow\",\"Action\":\"s3:GetObject\",\"Resource\":\"arn:aws:s3:::$BUCKET/digest.config.json\"},
  {\"Sid\":\"ConfigKey\",\"Effect\":\"Allow\",\"Action\":\"kms:Decrypt\",\"Resource\":\"$KEY_ARN\"},
  {\"Sid\":\"Data\",\"Effect\":\"Allow\",\"Action\":[\"elasticfilesystem:ClientMount\",\"elasticfilesystem:ClientWrite\"],
   \"Resource\":\"arn:aws:elasticfilesystem:$AWS_REGION:$ACCT:file-system/$FS\",
   \"Condition\":{\"StringEquals\":{\"elasticfilesystem:AccessPointArn\":\"arn:aws:elasticfilesystem:$AWS_REGION:$ACCT:access-point/$AP\"}}}]}"
```

KMS key policy: allow both roles `kms:Decrypt` (and the log service principal, step 1). Scheduler
role (starts the task, sends to the DLQ):

```bash
cat > trust-sched.json <<'JSON'
{"Version":"2012-10-17","Statement":[{"Effect":"Allow","Principal":{"Service":"scheduler.amazonaws.com"},"Action":"sts:AssumeRole"}]}
JSON
aws iam create-role --role-name $APP-scheduler --assume-role-policy-document file://trust-sched.json
aws iam put-role-policy --role-name $APP-scheduler --policy-name run --policy-document "{
 \"Version\":\"2012-10-17\",\"Statement\":[
  {\"Sid\":\"Run\",\"Effect\":\"Allow\",\"Action\":\"ecs:RunTask\",\"Resource\":\"arn:aws:ecs:$AWS_REGION:$ACCT:task-definition/$APP:*\",
   \"Condition\":{\"ArnEquals\":{\"ecs:cluster\":\"arn:aws:ecs:$AWS_REGION:$ACCT:cluster/$APP\"}}},
  {\"Sid\":\"Pass\",\"Effect\":\"Allow\",\"Action\":\"iam:PassRole\",
   \"Resource\":[\"arn:aws:iam::$ACCT:role/$APP-exec\",\"arn:aws:iam::$ACCT:role/$APP-task\"],
   \"Condition\":{\"StringLike\":{\"iam:PassedToService\":\"ecs-tasks.amazonaws.com\"}}},
  {\"Sid\":\"Dlq\",\"Effect\":\"Allow\",\"Action\":\"sqs:SendMessage\",\"Resource\":\"arn:aws:sqs:$AWS_REGION:$ACCT:$APP-dlq\"},
  {\"Sid\":\"DlqKey\",\"Effect\":\"Allow\",\"Action\":\"kms:GenerateDataKey\",\"Resource\":\"$KEY_ARN\"}]}"
```

### Step 6. Logs, cluster, task definition

```bash
aws logs create-log-group --log-group-name /$APP --kms-key-id $KEY_ARN
aws logs put-retention-policy --log-group-name /$APP --retention-in-days 90
aws ecs create-cluster --cluster-name $APP
```

The task has two containers. `config` (non-essential) copies the config from S3 into a shared
volume and exits; `digest` waits for it, then runs. The AWS CLI image name is
`public.ecr.aws/aws-cli/aws-cli` (**unverified**; confirm in the ECR Public gallery). Save as
`taskdef.json` after replacing the `${…}` placeholders (use `envsubst < taskdef.tpl.json`):

```json
{
  "family": "eng-digest",
  "requiresCompatibilities": ["FARGATE"],
  "networkMode": "awsvpc",
  "cpu": "1024",
  "memory": "2048",
  "runtimePlatform": { "cpuArchitecture": "X86_64", "operatingSystemFamily": "LINUX" },
  "executionRoleArn": "arn:aws:iam::${ACCT}:role/eng-digest-exec",
  "taskRoleArn": "arn:aws:iam::${ACCT}:role/eng-digest-task",
  "volumes": [
    { "name": "cfg" },
    {
      "name": "data",
      "efsVolumeConfiguration": {
        "fileSystemId": "${FS}",
        "transitEncryption": "ENABLED",
        "authorizationConfig": { "accessPointId": "${AP}", "iam": "ENABLED" }
      }
    }
  ],
  "containerDefinitions": [
    {
      "name": "config",
      "image": "public.ecr.aws/aws-cli/aws-cli:latest",
      "essential": false,
      "entryPoint": ["aws", "s3", "cp"],
      "command": ["s3://${BUCKET}/digest.config.json", "/cfg/digest.config.json"],
      "mountPoints": [{ "sourceVolume": "cfg", "containerPath": "/cfg" }],
      "logConfiguration": {
        "logDriver": "awslogs",
        "options": {
          "awslogs-group": "/eng-digest",
          "awslogs-region": "${AWS_REGION}",
          "awslogs-stream-prefix": "config"
        }
      }
    },
    {
      "name": "digest",
      "image": "${ECR_URI}:phase0",
      "essential": true,
      "dependsOn": [{ "containerName": "config", "condition": "SUCCESS" }],
      "command": ["-c", "/cfg/digest.config.json", "run"],
      "environment": [
        { "name": "OLLAMA_URL", "value": "${OLLAMA_URL}" },
        { "name": "DIGEST_HOST_OS", "value": "linux" },
        { "name": "DIGEST_HOST_ARCH", "value": "x86_64" },
        { "name": "LOG_LEVEL", "value": "info" }
      ],
      "secrets": [
        { "name": "SMTP_PASSWORD", "valueFrom": "${SECRET_ARN}:SMTP_PASSWORD::" },
        { "name": "SLACK_WEBHOOK_URL", "valueFrom": "${SECRET_ARN}:SLACK_WEBHOOK_URL::" },
        { "name": "GITHUB_TOKEN", "valueFrom": "${SECRET_ARN}:GITHUB_TOKEN::" }
      ],
      "mountPoints": [
        { "sourceVolume": "cfg", "containerPath": "/cfg", "readOnly": true },
        { "sourceVolume": "data", "containerPath": "/app/data" }
      ],
      "stopTimeout": 120,
      "logConfiguration": {
        "logDriver": "awslogs",
        "options": {
          "awslogs-group": "/eng-digest",
          "awslogs-region": "${AWS_REGION}",
          "awslogs-stream-prefix": "digest"
        }
      }
    }
  ]
}
```

```bash
aws ecs register-task-definition --cli-input-json file://taskdef.json
```

`DIGEST_HOST_ARCH=x86_64` is what `uname -m` prints on Linux; `resolveHostPlatform` then picks the
Linux fallback profile. Drop any secret line for a key you did not store. The image's default
command is `serve`; `command` above replaces it with `-c … run`, so the entrypoint stays
`node dist/cli.js`. Console check: ECS → Task definitions → eng-digest → JSON.

### Step 7. Smoke test, by hand

```bash
aws ec2 start-instances --instance-ids $OLLAMA_ID     # id from the console
aws ec2 wait instance-status-ok --instance-ids $OLLAMA_ID
aws ecs run-task --cluster $APP --launch-type FARGATE --task-definition $APP \
  --network-configuration "awsvpcConfiguration={subnets=[$SUBNET],securityGroups=[$SG_TASK],assignPublicIp=ENABLED}" \
  --overrides '{"containerOverrides":[{"name":"digest","command":["-c","/cfg/digest.config.json","run","--dry-run"]}]}'
aws logs tail /$APP --follow --since 5m
```

`--dry-run` writes the digest to `/app/data` and sends nothing. Look for the `runId` lines and
status `dry-run`. When that works, run it once without `--dry-run`. Stop the instance afterwards:
`aws ec2 stop-instances --instance-ids $OLLAMA_ID`.

### Step 8. Schedule, DLQ, alarm

```bash
aws sqs create-queue --queue-name $APP-dlq --attributes KmsMasterKeyId=$KEY_ID
aws sns create-topic --name $APP-alerts --attributes KmsMasterKeyId=alias/$APP
aws sns subscribe --topic-arn arn:aws:sns:$AWS_REGION:$ACCT:$APP-alerts --protocol email --notification-endpoint you@example.com
```

Confirm the subscription from the email. The weekly schedule, Monday 07:00 in the config's time
zone (match `schedule.timeZone` in `digest.config.json`), retried briefly, DLQ on failure to start:

```bash
cat > target.json <<JSON
{
  "Arn": "arn:aws:scheduler:::aws-sdk:ecs:runTask",
  "RoleArn": "arn:aws:iam::$ACCT:role/$APP-scheduler",
  "Input": "{\"Cluster\":\"$APP\",\"TaskDefinition\":\"$APP\",\"LaunchType\":\"FARGATE\",\"Count\":1,\"NetworkConfiguration\":{\"AwsvpcConfiguration\":{\"Subnets\":[\"$SUBNET\"],\"SecurityGroups\":[\"$SG_TASK\"],\"AssignPublicIp\":\"ENABLED\"}}}",
  "RetryPolicy": { "MaximumRetryAttempts": 3, "MaximumEventAgeInSeconds": 3600 },
  "DeadLetterConfig": { "Arn": "arn:aws:sqs:$AWS_REGION:$ACCT:$APP-dlq" }
}
JSON
aws scheduler create-schedule --name $APP-weekly --flexible-time-window Mode=OFF \
  --schedule-expression "cron(0 7 ? * MON *)" --schedule-expression-timezone Europe/Berlin \
  --target file://target.json
```

The `RunTask` field names are `PascalCase` in this universal target (**unverified**; the Scheduler
target page did not load, so compare with the console form: EventBridge → Scheduler → Schedules →
Create schedule → Templated targets → ECS RunTask). The Scheduler retries only when `RunTask`
itself fails (no capacity, bad role). A task that starts and exits 1 is not retried; that is what
the alarm in the next step is for. Run `aws scheduler get-schedule --name $APP-weekly` and confirm
`State: ENABLED`.

Alarm on a failed exit. ECS emits a "Task State Change" event when a task stops
([ECS events](https://docs.aws.amazon.com/AmazonECS/latest/developerguide/ecs_cwe_events.html),
read 2026-10-17). The `containers[].exitCode` field is part of that event but was not shown on the
page I read (**unverified**); check one real event in the console (EventBridge → Rules → Sandbox)
before relying on the pattern. Exits 2 (blocked) and 3 (quiet) are not failures and must not page,
so match anything other than 0, 2 and 3. That covers exit 1 and also 137 (out of memory):

```bash
aws events put-rule --name $APP-failed --event-pattern '{
  "source":["aws.ecs"],"detail-type":["ECS Task State Change"],
  "detail":{"clusterArn":["arn:aws:ecs:'$AWS_REGION':'$ACCT':cluster/'$APP'"],
            "lastStatus":["STOPPED"],
            "containers":{"name":["digest"],"exitCode":[{"anything-but":[0,2,3]}]}}}'
aws events put-targets --rule $APP-failed --targets "Id=sns,Arn=arn:aws:sns:$AWS_REGION:$ACCT:$APP-alerts"
```

Also add a topic policy letting `events.amazonaws.com` publish (console: SNS → Topics → eng-digest-alerts
→ Access policy). `anything-but` on numbers is documented under EventBridge content filtering
(**unverified** here).

### Step 9. Verify end to end

1. Run the task by hand with `aws ecs run-task` and a bogus `OLLAMA_URL` override. The run ends
   `failed` (exit 1) and an email arrives from SNS within a minute.
2. Run `aws scheduler get-schedule` and check the next run in the console (EventBridge → Scheduler).
3. After the first real week: `aws logs filter-log-events --log-group-name /$APP --filter-pattern '{ $.status = "sent" }'`
   (logs are pino JSON), and look for `runs/<week>/run.json` on the file system via
   `aws ecs execute-command` or a one-off task that mounts the same access point.

Rollback: `aws scheduler delete-schedule --name $APP-weekly`. Remove resources in reverse order
(`aws efs`, `aws iam`, `aws kms schedule-key-deletion --pending-window-in-days 7`).

## 6. Not doing

- **Multi-tenant.** One config, one list of sources, one set of recipients per deployment.
  Separate teams get separate stacks, not tenant ids in the code.
- **Web UI or an API.** Delivery stays Markdown, email and Slack.
- **SageMaker.** It would need a custom container for Ollama and its own adapter, for no benefit
  over a single EC2 instance at one run per week.
- **Lambda and Step Functions.** Lambda's 15-minute limit is below the reference run time; per-step
  Step Functions would need `runDigest` to resume from saved state (see section 7.2 of the design).
- **A GPU instance left running**, a NAT gateway, and interface endpoints in phase 0.
- **Changes to `src/` in this document's scope.** W7-10 builds the phase 0 files; B's adapters are
  not started.

## Sources (read 2026-10-17)

| Claim                                                                                                                                                                                             | Source                                                                                                                 |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| Fargate Linux/x86 $0.000011244 per vCPU-s, $0.000001235 per GB-s, 20 GB free ephemeral                                                                                                            | <https://aws.amazon.com/fargate/pricing/>                                                                              |
| g5.xlarge $1.006/h on-demand, 4 vCPU, 16 GiB, A10G 24 GiB (third party)                                                                                                                           | <https://instances.vantage.sh/aws/ec2/g5.xlarge?region=us-east-1>                                                      |
| g6e.xlarge $1.861/h (third party, **unverified**)                                                                                                                                                 | <https://compute.doit.com/spot/us-east-1/g6e.xlarge>                                                                   |
| Bedrock Gemma 4 31B $0.14/$0.40, Gemma 4 E2B $0.04/$0.08, Qwen3 Next 80B A3B $0.15/$1.20 per M tokens, US East; Guardrails content filters $0.15, contextual grounding $0.10 per 1,000 text units | <https://aws.amazon.com/bedrock/pricing/>                                                                              |
| NAT gateway $0.045/h and per GB (us-east-2 example), public IPv4 $0.005/h                                                                                                                         | <https://aws.amazon.com/vpc/pricing/>                                                                                  |
| Secrets Manager $0.40 per secret-month, $0.05 per 10,000 calls (from worked examples)                                                                                                             | <https://aws.amazon.com/secrets-manager/pricing/>                                                                      |
| KMS $1.00 per key-month, 20,000 free requests                                                                                                                                                     | <https://aws.amazon.com/kms/pricing/>                                                                                  |
| SES $0.10 per 1,000 emails                                                                                                                                                                        | <https://aws.amazon.com/ses/pricing/>                                                                                  |
| CloudWatch: 5 GB logs free, $0.10 per alarm metric (examples only)                                                                                                                                | <https://aws.amazon.com/cloudwatch/pricing/>                                                                           |
| EventBridge Scheduler 14,000,000 free invocations per month                                                                                                                                       | <https://aws.amazon.com/eventbridge/pricing/>                                                                          |
| ECR private storage $0.10/GB-month (example)                                                                                                                                                      | <https://aws.amazon.com/ecr/pricing/>                                                                                  |
| EBS gp3 $0.08/GB-month (the page's example, region not named; **unverified**)                                                                                                                     | <https://aws.amazon.com/ebs/pricing/>                                                                                  |
| S3 conditional writes (`If-None-Match`, `If-Match`)                                                                                                                                               | <https://docs.aws.amazon.com/AmazonS3/latest/userguide/conditional-writes.html>                                        |
| ECS secrets from Secrets Manager as env vars, JSON key syntax, platform 1.4.0                                                                                                                     | <https://docs.aws.amazon.com/AmazonECS/latest/developerguide/secrets-envvar-secrets-manager.html>                      |
| ECS task state change events                                                                                                                                                                      | <https://docs.aws.amazon.com/AmazonECS/latest/developerguide/ecs_cwe_events.html>                                      |
| Scheduler ECS target, retry policy, DLQ                                                                                                                                                           | <https://docs.aws.amazon.com/scheduler/latest/UserGuide/managing-targets-ecs.html> (page did not load; **unverified**) |
| S3 Standard storage and request rates, EFS price, interface endpoint price, DNS Firewall, Nova and Claude prices                                                                                  | not read: **unverified**                                                                                               |
