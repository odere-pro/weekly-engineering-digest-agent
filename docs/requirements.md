# Requirements and readiness

What must be true on a machine before the first run. Every number comes from the code or the
docs named next to it. Model sizes were checked on **2026-10-17**. A figure that could not be
verified on the reference laptop (Apple M1 Pro, 32 GB) is marked **unverified** with its source.

## 1. Hardware per profile

| Profile   | RAM                                                                        | Disk for models                                    | Disk for `data/` | CPU or GPU                     | Apple silicon              | Run time per week                                  |
| --------- | -------------------------------------------------------------------------- | -------------------------------------------------- | ---------------- | ------------------------------ | -------------------------- | -------------------------------------------------- |
| `quality` | about 32 GB (`init` warns below it; unverified: README, `src/cli/init.ts`) | 65.9 GB (section 3); README says "40 GB", see note | not measured     | Apple GPU through Ollama (MLX) | required for the tuned set | about 1 hour (README, `init`; one run, unverified) |
| `fast`    | not measured                                                               | 32.7 GB (section 3)                                | not measured     | Apple GPU through Ollama (MLX) | required for the tuned set | not measured                                       |
| `light`   | fits in 16 GB (README, `init`; unverified)                                 | 20.2 GB (section 3)                                | not measured     | Apple GPU through Ollama (MLX) | required for the tuned set | 320 s mean, 219 s to 516 s (`docs/profiles.md`)    |
| fallback  | much more than 16 GB; not measured                                         | about 45 GB (section 3)                            | not measured     | any machine Ollama supports    | no                         | not measured                                       |

Notes:

- Steps run one after another and `OLLAMA_MAX_LOADED_MODELS=1` keeps one model in memory, so
  the RAM need follows the largest single model: 22 GB for `nemotron-3.5-lightning:30b-mlx`
  (`quality`, `fast`), 18 GB for `clef:latest` (fallback), 9.5 GB for `light`. Those are the
  on-disk sizes, a lower bound for the loaded size (unverified).
- The README says `quality` needs "40 GB of disk". The four tags add up to 65.9 GB, so plan for
  that until the README is corrected (follow-up for the README owner).
- `data/` holds run records, the lock and the Markdown digests. No size was measured; it grows
  by one run record per week.
- "Run time" is one replayed week on the reference laptop with every guard on.
- On a machine that is not an Apple silicon Mac every profile falls back to the untuned set
  (section 3); `digest doctor` says so.

## 2. Software

| Needs                      | Version                                                         | Source                          |
| -------------------------- | --------------------------------------------------------------- | ------------------------------- |
| Node.js                    | 24 or newer                                                     | `package.json` `engines`        |
| pnpm                       | 10 (pinned `10.33.4`)                                           | `package.json` `packageManager` |
| Docker with Compose        | 2.24 or newer (Docker route only)                               | README Install                  |
| Ollama                     | 0.40.0 or newer for `quality`, `fast`, `light` on Apple silicon | `src/config/profiles.ts`        |
| Ollama (fallback set)      | 0.35.1 or newer                                                 | `src/config/profiles.ts`        |
| `OLLAMA_MAX_LOADED_MODELS` | `1` on a host Ollama                                            | README Profiles                 |

Docker on a Mac cannot use the Apple GPU, so Ollama runs on the host as the Ollama app and the
container talks to it. On Linux, Compose adds its own Ollama.

## 3. Models per profile

Sizes are the download sizes. For tags installed on the reference laptop they are the `SIZE`
column of `ollama list` (2026-10-17). `gemma4:31b` is not installed there, so its size is from
the Ollama library tags page ([ollama.com/library/gemma4](https://ollama.com/library/gemma4/tags),
2026-10-17), which shows 19 GB to 20 GB: **unverified locally**.

Totals count each tag once, even when two roles share it.

### `quality`

| Tag                              | Roles                         | Download size |
| -------------------------------- | ----------------------------- | ------------- |
| `clef:latest`                    | classify, policy guard, judge | 18 GB         |
| `granite4.1-guardian:8b`         | risk guard                    | 6.9 GB        |
| `gemma4:31b-mlx`                 | writer                        | 19 GB         |
| `nemotron-3.5-lightning:30b-mlx` | writer                        | 22 GB         |
| **Total**                        |                               | **65.9 GB**   |

### `fast`

| Tag                              | Roles                  | Download size |
| -------------------------------- | ---------------------- | ------------- |
| `strands-decider:2b-mlx-bf16`    | classify, policy guard | 3.8 GB        |
| `granite4.1-guardian:8b`         | risk guard             | 6.9 GB        |
| `nemotron-3.5-lightning:30b-mlx` | writer (no judge)      | 22 GB         |
| **Total**                        |                        | **32.7 GB**   |

### `light`

| Tag                           | Roles                  | Download size |
| ----------------------------- | ---------------------- | ------------- |
| `strands-decider:2b-mlx-bf16` | classify, policy guard | 3.8 GB        |
| `granite4.1-guardian:8b`      | risk guard             | 6.9 GB        |
| `gemma4:e4b-mlx`              | writer (no judge)      | 9.5 GB        |
| **Total**                     |                        | **20.2 GB**   |

### Fallback set (every profile, off Apple silicon)

| Tag                      | Roles                  | Download size               |
| ------------------------ | ---------------------- | --------------------------- |
| `clef:latest`            | classify, policy guard | 18 GB                       |
| `granite4.1-guardian:8b` | risk guard             | 6.9 GB                      |
| `gemma4:31b`             | writer (no judge)      | 19 GB to 20 GB (unverified) |
| **Total**                |                        | **about 44 GB to 45 GB**    |

A guard that is switched off in the config needs no model, so the real set can be smaller;
`digest doctor` lists what the current config needs. Pull on the host with `ollama pull <tag>`;
`doctor` prints the exact line for each missing model. Licences: README "Model licences".

## 4. Network

| Host                                                                                                                                                                                                                                                      | When                                   | Why                                                        |
| --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------- | ---------------------------------------------------------- |
| `openai.com`, `deepmind.google`, `blog.google`, `mistral.ai`, `huggingface.co`, `pytorch.org`, `ollama.com`, `github.com`, `nodejs.org`, `kubernetes.io`, `www.docker.com`, `github.blog`, `aws.amazon.com`, `docs.cloud.google.com`, `www.microsoft.com` | each run (collection)                  | the allowlisted feeds in `docs/sources.md`                 |
| `api.github.com`                                                                                                                                                                                                                                          | each run, only with `GITHUB_TOKEN` set | GitHub REST mode instead of the Atom feed                  |
| `ollama.com`                                                                                                                                                                                                                                              | once per model                         | `ollama pull` (also the `ollama-blog` feed)                |
| `localhost:11434` (or `OLLAMA_URL`)                                                                                                                                                                                                                       | each run                               | the local Ollama; nothing leaves the machine for inference |
| your SMTP host and port (587, or 465 for implicit TLS)                                                                                                                                                                                                    | only if `delivery.email` is set        | email delivery; host from the config, secret in `.env`     |
| your Slack webhook (`https:` only)                                                                                                                                                                                                                        | only if `delivery.slack.enabled`       | Slack delivery; URL from `SLACK_WEBHOOK_URL`               |

A redirect is followed only to the same host (see `docs/sources.md`). Recipients and endpoints
come from `digest.config.json` and `.env` only. No model API or cloud service is called.

## 5. Readiness checklist

Run these in order. Use `pnpm digest <command>` for the Node route, or
`docker compose run --rm digest <command>` for Docker.

1. **Hardware.** Match your machine to section 1. Green: RAM and free disk cover your profile.
2. **Software.** `node --version` (v24 or higher), `pnpm --version` (10.x), and for Docker
   `docker compose version` (2.24 or higher). Green: all three meet section 2.
3. **Ollama.** Install the [Ollama app](https://ollama.com/download), then `ollama --version`.
   Green: 0.40.0 or higher (0.35.1 for the fallback set). On a host Ollama set
   `OLLAMA_MAX_LOADED_MODELS=1` and restart it.
4. **Clone and install.** `pnpm install --frozen-lockfile`. Green: exits 0.
5. **Pull the models.** `ollama pull <tag>` for every tag of your profile (section 3), then
   `ollama list`. Green: every tag is listed.
6. **Network.** The hosts in section 4 are reachable from this machine. Green: step 8 shows
   every feed `✓`.
7. **Configure.** `pnpm digest init` (Docker on a Mac: `make docker-init`). Green: it writes
   `digest.config.json` and `.env` (mode 600) and names your profile.
8. **Check everything.** `pnpm digest doctor`. Green: every line is `✓`. These warnings (`!`)
   are acceptable: delivery secrets you do not use, and `light` or any Mac profile running on a
   machine you accept falls back to the untuned set. Any `✗` must be fixed first; the line
   says how.
9. **Trial run.** `pnpm digest run --dry-run`. Green: it writes the digest to disk, sends
   nothing and exits 0. Expect about 5 minutes for `light` on the reference laptop.

Step 8 is the gate: do not schedule weekly runs until `digest doctor` shows no `✗`.

## 6. Not supported

- Docker on a Mac cannot use the Apple GPU. Run Ollama on the host and the app in the container.
- Off Apple silicon the MLX tags and `strands-decider` do not run. Every profile falls back to
  the untuned set, with no judge.
- `light` off Apple silicon is the heavy fallback (about 45 GB of models, much more than 16 GB
  of RAM), not the 16 GB profile.
- Node older than 24, and Ollama older than 0.40.0 (0.35.1 for the fallback).
- More than one model loaded at a time (`OLLAMA_MAX_LOADED_MODELS` above 1) is not tested.
- Hosted model APIs. The agent runs on Ollama only.
- Feed or release sources outside the allowlist in `docs/sources.md`.
