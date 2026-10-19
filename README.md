# Engineering Digest Agent

A weekly digest of the 3-5 AI and platform engineering releases that matter to your team.
It reads a fixed list of RSS feeds and GitHub releases, drops hype and minor releases, writes a
short digest, checks it, and delivers it as a Markdown file, an HTML page, email or Slack.

Everything runs on your own machine with [Ollama](https://ollama.com). No cloud, no API keys,
no cost per run.

## Why

- **Free.** $0 a month. The models run locally.
- **Private.** Nothing leaves the machine except the feed requests and the delivery you turn on.
- **Guarded.** Feed text is untrusted. Fixed rules and models screen it before writing, and models
  check the drafts. Every link in the digest must come from a collected item.
- **Short.** Each item says what changed and what to do. Items are sorted by urgency.

## Example

```markdown
# Week 2026-W42: 5 releases, 1 needs action

_A security fix to ship now, and two platform releases to read_

## 🔴 Act now

| Release                                                                      | What changed                                                                          | What to do                             |
| ---------------------------------------------------------------------------- | ------------------------------------------------------------------------------------- | -------------------------------------- |
| [OpenTofu 1.12.8](https://github.com/opentofu/opentofu/releases/tag/v1.12.8) | Security fix: a crafted module source could read files outside the working directory. | Upgrade OpenTofu in CI and on laptops. |
```

## Cost and hardware

| Profile   | RAM                              | Disk for models | Run time per week              | Measured |
| --------- | -------------------------------- | --------------- | ------------------------------ | -------- |
| `light`   | 16 GB, Apple silicon only        | about 20 GB     | about 6 min (340 s on average) | yes      |
| `fast`    | not measured, Apple silicon only | about 33 GB     | not measured                   | no       |
| `quality` | 32 GB, Apple silicon only        | about 66 GB     | about 1 h                      | no       |

Other machines run an untuned fallback set (about 45 GB of models). Node 24 and Ollama 0.40 or
newer are needed. More: [cost and hardware](docs/overview/cost-and-hardware.md).

## Status and limits

This is v0.1.0 plus fixes ([changelog](CHANGELOG.md)). It is not published to npm: install from
a clone.

- Only `light` has a measured baseline. Three of the four hard quality gates pass; **format is
  at 83%** because one recorded week produced no digest. See [results](docs/evaluation/results.md).
- The guards can reject good drafts. When every draft is rejected, the week is sent as a fallback
  digest made from the sources' own words (no model wrote it), not as a failure note.
- Feeds are an allowlist of 24 sources ([list](docs/sources.md)).
- One machine, one run at a time. The cloud is a [proposal](docs/operations/cloud-proposal.md) only.

All limits: [known limits](docs/operations/known-limits.md).

## Quick start

```bash
git clone https://github.com/odere-pro/weekly-engineering-digest-agent.git
cd weekly-engineering-digest-agent
pnpm install --frozen-lockfile
pnpm digest init            # asks for focus areas, profile and delivery
pnpm digest doctor          # checks Ollama, models, feeds; prints a fix for each problem
pnpm digest run --dry-run   # a full run that sends nothing
```

Pull the models first with `ollama pull <tag>`; `doctor` prints the exact line for each missing
model. The digest lands in `dist/digests` (`data/digests` in Docker). Docker setup and
scheduling: [getting started](docs/overview/getting-started.md).

## Documentation

The full wiki is in [`docs/`](docs/README.md).

| Read                                          | For                                              |
| --------------------------------------------- | ------------------------------------------------ |
| [Overview](docs/overview/README.md)           | What it does, cost, status                       |
| [Runbooks](docs/runbooks/README.md)           | One page per task: set up, configure, run, debug |
| [Architecture](docs/architecture/README.md)   | Ports and adapters, data flow, safety            |
| [Configuration](docs/configuration/README.md) | Every setting                                    |
| [Evaluation](docs/evaluation/README.md)       | How quality is measured, current results         |
| [Reference](docs/reference/README.md)         | Commands, exit codes, config keys, glossary      |
| [`CLAUDE.md`](CLAUDE.md)                      | Code map and rules for contributors              |

MIT license. The models are licensed separately ([model licences](docs/reference/model-licences.md)).
