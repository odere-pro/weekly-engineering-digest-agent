# Profiles

Part of [Configuration](README.md).

A profile is a named set of Ollama models, one for each job (role). You choose it with one key,
`profile`. The code asks for a role such as `classify` or `write`, and the profile says which
model tag answers.

| Key       | Type                         | Default   |
| --------- | ---------------------------- | --------- |
| `profile` | `quality`, `fast` or `light` | `quality` |

`digest init` suggests `light` and writes it with `--yes`, because `light` is the only profile with
a measured baseline. A config file with no `profile` key gets `quality`.

## The tags per role

| Role                      | `quality`                                          | `fast`                           | `light`                       | Fallback (not Apple silicon) |
| ------------------------- | -------------------------------------------------- | -------------------------------- | ----------------------------- | ---------------------------- |
| `classify`, `guardPolicy` | `clef:latest`                                      | `strands-decider:2b-mlx-bf16`    | `strands-decider:2b-mlx-bf16` | `clef:latest`                |
| `guardRisk`               | `granite4.1-guardian:8b`                           | `granite4.1-guardian:8b`         | `granite4.1-guardian:8b`      | `granite4.1-guardian:8b`     |
| `write` (the panel)       | `gemma4:31b-mlx`, `nemotron-3.5-lightning:30b-mlx` | `nemotron-3.5-lightning:30b-mlx` | `gemma4:e4b-mlx`              | `gemma4:31b`                 |
| `judge`                   | `clef:latest`                                      | none                             | none                          | none                         |
| Ollama minimum            | 0.40.0                                             | 0.40.0                           | 0.40.0                        | 0.35.1                       |
| Models to pull, about     | 66 GB                                              | 33 GB                            | 20 GB                         | 45 GB                        |
| RAM                       | 32 GB (tight), 48 GB or more (estimate)            | not measured                     | 16 GB                         | not measured                 |

Disk sizes are approximate registry sizes, and the RAM figures are what `digest init` and
`doctor --readiness` use. The tags come from `src/config/profiles.ts`.
With two writers (`quality`) a judge picks the better draft. With one writer there is no judge and no
select step: see [judge](judge.md). A writer panel that shares a model family with the judge fails at
config load with a readable message.

## Apple silicon and the fallback

The MLX tags and `strands-decider` run only on a Mac with Apple silicon. On any other machine
every profile resolves to the fallback set, and `digest doctor` warns about it. The profile name
in `run.json` stays the one you configured. `modelsByRole` there shows the tags that really ran.

The machine is the one **Ollama** runs on, not always the one running `digest`. In Docker on a
Mac the app runs in a Linux container and Ollama runs on the host. Two variables name the host:

| Variable           | Accepts                                              |
| ------------------ | ---------------------------------------------------- |
| `DIGEST_HOST_OS`   | `darwin`, `linux`, `windows`, or `uname -s` spelling |
| `DIGEST_HOST_ARCH` | `arm64`, `aarch64`, `x86_64`, `x64`, `amd64`         |

`make docker-*` sets both from `uname`. A blank value counts as not set. Any other value stops the
command with `Invalid DIGEST_HOST_OS "<value>": use darwin, linux or windows`. Details in
[environment](environment.md).

On Docker with Linux Compose the `model-pull` service pulls the fallback set (`clef:latest`,
`granite4.1-guardian:8b` and `gemma4:31b`, or the tags in `models.writers`).

## Check this machine

```bash
pnpm digest doctor --readiness
```

It prints the machine (OS, Apple silicon, RAM, free disk, Node, Ollama) and one verdict per
profile: `ready`, `pull models` or `not for this machine`. It needs no config file and calls only
Ollama. It exits 0 when at least one profile is ready or needs only a pull, and 1 when none fits.
RAM counts as enough within a 5% tolerance of 32 GiB (`quality`) or 16 GiB (`light`). `quality` ran
on a 32 GB Mac but swapped (8 of 9 GB of swap in use, input guard alone 65 min), so `digest init`
also warns at 32 GiB and stays quiet from 48 GiB, an estimate that has not been measured. For `fast`
and the fallback the check only asks for the 16 GiB floor and shows `yes (not measured)`.

`pnpm digest doctor` (without the flag) checks the profile in your config: Ollama version against
the minimum above, Apple silicon, and one `model <tag>` line per model in use.

## Speed and licences

Only `light` has a measured baseline. See [evaluation results](../evaluation/results.md) for its
numbers. Model licences are in [model licences](../reference/model-licences.md).

## Change it

- [Choose a profile and pull its models](../runbooks/set-up/choose-profile-and-pull-models.md)
- [Change models or writers](../runbooks/configure/change-models-or-writers.md)
- [Upgrade models](../runbooks/maintain/upgrade-models.md)

## Related

- [Models](models.md) and [judge](judge.md)
- [Cost and hardware](../overview/cost-and-hardware.md)
- [src/config/CLAUDE.md](../../src/config/CLAUDE.md)
