# Engineering Digest Agent

A weekly digest of the 3-5 AI and platform engineering releases that matter to your team.
It reads a fixed list of RSS feeds and GitHub releases, drops hype and minor releases, writes a
short digest, checks it, and delivers it as a Markdown file, an HTML page, email or Slack.

Everything runs on your own machine with [Ollama](https://ollama.com). No cloud, no API keys,
no cost per run.

## Why

- **Free.** $0 a month. The models run locally.
- **Private.** Nothing leaves the machine except the feed requests and the delivery you turn on.
- **Guarded.** Feed text is untrusted. Models check it before and after writing. Every link in
  the digest must come from a collected item.
- **Short.** Each item says what changed and what to do. Items are sorted by urgency.

## Example

```markdown
# Week 2026-W42: 5 releases, 1 needs action

_A security fix to ship now, and two platform releases to read_

## 🔴 Act now

| Release                                                                      | What changed                                                                          | What to do                             |
| ---------------------------------------------------------------------------- | ------------------------------------------------------------------------------------- | -------------------------------------- |
| [OpenTofu 1.12.8](https://github.com/opentofu/opentofu/releases/tag/v1.12.8) | Security fix: a crafted module source could read files outside the working directory. | Upgrade OpenTofu in CI and on laptops. |

## 🟡 Worth a look

| Release                                                                    | What changed                                                                       | Relevant if you                       |
| -------------------------------------------------------------------------- | ---------------------------------------------------------------------------------- | ------------------------------------- |
| [Kubernetes 1.36](https://kubernetes.io/blog/2026/10/08/kubernetes-v1-36/) | Sidecar containers are stable and the last deprecated admission flags are removed. | run your own clusters or Helm charts. |

## ⚪ Good to know

| Release                                                    | What changed                                                         |
| ---------------------------------------------------------- | -------------------------------------------------------------------- |
| [Node.js 24.9](https://nodejs.org/en/blog/release/v24.9.0) | A routine release with fixes to the test runner and the HTTP client. |
```

## Cost and hardware

| Profile   | RAM                              | Disk for models | Run time per week              | Measured |
| --------- | -------------------------------- | --------------- | ------------------------------ | -------- |
| `light`   | 16 GB, Apple silicon only        | about 20 GB     | about 5 min (320 s on average) | yes      |
| `fast`    | not measured, Apple silicon only | about 33 GB     | not measured                   | no       |
| `quality` | 32 GB, Apple silicon only        | about 66 GB     | about 1 h                      | no       |

Other machines run an untuned fallback set (about 45 GB of models, far more than 16 GB of RAM).
Node 24 and Ollama 0.40 or newer are needed. The profile table is in
[`docs/how-it-works.md`](docs/how-it-works.md#profiles).

## Status and limits

This is v0.1.0 plus fixes (see [`CHANGELOG.md`](CHANGELOG.md)). It is not published to npm;
install from a clone.

- Only `light` has a measured baseline. `quality` and `fast` have none.
- Two of the four hard quality gates are red on that baseline: format (83%, needs 100%) and
  attack handling (90%, needs 100%). The format cause is fixed. The attack miss is not. The
  baseline has not been re-run since the fixes.
- The guards can block good drafts. A blocked week sends a failure note, not a digest.
- Feeds are an allowlist of 24 sources ([`docs/sources.md`](docs/sources.md)). GitHub keeps
  only the latest 10 releases per repository, so a busy week can lose some.
- One machine, one run at a time. No multi-user setup. The cloud is a proposal only
  ([`docs/cloud.md`](docs/cloud.md)).

## Quick start

**Docker on a Mac** (Ollama runs on the host, because Docker cannot use the Apple GPU):

```bash
git clone https://github.com/odere-pro/weekly-engineering-digest-agent.git
cd weekly-engineering-digest-agent
make docker-init   # writes digest.config.json and .env, then runs "digest init"
make docker-up     # starts the weekly scheduler
```

**Docker on Linux** (Compose adds its own Ollama):

```bash
mkdir -p data && touch digest.config.json && (umask 077 && touch .env)
echo "DIGEST_UID=$(id -u)" >> .env && echo "DIGEST_GID=$(id -g)" >> .env
docker compose run --rm --no-deps digest init
docker compose --profile linux up -d
```

**Node** (24 or newer, pnpm, Ollama on the same host):

```bash
pnpm install --frozen-lockfile
pnpm digest init            # asks for focus areas, profile and delivery
pnpm digest doctor          # checks Ollama, models, feeds; prints a fix for each problem
pnpm digest run --dry-run   # a full run that sends nothing
```

Pull the models first with `ollama pull <tag>`. `doctor` prints the exact line for each missing
model. In Docker, put `docker compose run --rm digest` in front of each `digest` command.

**Where the digest lands:** `<week>.md` and `<week>.html` in `dist/digests` (Node) or
`data/digests` (Docker). `run --out <dir>` picks another folder. A dry run writes the files too.
Set up email or Slack with `digest init`.

## More

| Read                                           | For                                                          |
| ---------------------------------------------- | ------------------------------------------------------------ |
| [`docs/how-it-works.md`](docs/how-it-works.md) | The pipeline, models, data, safety rules, known limits       |
| [`docs/operate.md`](docs/operate.md)           | Commands, config, first run, what to do when a run fails     |
| [`docs/sources.md`](docs/sources.md)           | The feed list and fetch limits                               |
| [`docs/profiles.md`](docs/profiles.md)         | Measured speed and quality per profile                       |
| [`docs/licences.md`](docs/licences.md)         | Model licences (a reading of public pages, not legal advice) |
| [`docs/cloud.md`](docs/cloud.md)               | The AWS proposal. Nothing is built                           |
| [`CHANGELOG.md`](CHANGELOG.md)                 | What changed                                                 |
| [`CLAUDE.md`](CLAUDE.md)                       | Code map and rules for contributors                          |

MIT license. The models are licensed separately.
