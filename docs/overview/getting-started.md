# Getting started

Part of [Overview](README.md).

The shortest path from a clone to a first digest. Each step links to a runbook with the full
detail and the fixes for when it goes wrong.

## 1. Check the machine

Node 24 or newer (or Docker Compose 2.24 or newer) and Ollama 0.40.0 or newer. RAM and disk
depend on the profile: [cost and hardware](cost-and-hardware.md).

## 2. Install

Pick one:

- [Install with Docker Compose](../runbooks/set-up/install-with-compose.md)
- [Install with Node](../runbooks/set-up/install-with-node.md)

## 3. Pull the models

[Choose a profile and pull models](../runbooks/set-up/choose-profile-and-pull-models.md).
`digest doctor` prints the exact `ollama pull` line for each missing model.

## 4. First run

```bash
pnpm digest init            # asks for focus areas, profile and delivery; shows where files are saved
pnpm digest doctor          # checks Ollama, models, feeds; prints a fix for each problem
pnpm digest run --dry-run   # a full run that sends nothing
```

Details and expected output: [first run](../runbooks/set-up/first-run.md). Do not schedule weekly
runs before the dry run works.

## 5. Find the digest

`<week>.md` and `<week>.html` land in the week's folder, `dist/<monday>/digest/` (for `2026-W43`:
`dist/2026-10-19/digest/`), on Node and, through the `./dist` mount, in Docker. A dry
run writes the files too. See [files and paths](../reference/files-and-paths.md).

## 6. Schedule it

[Schedule weekly runs](../runbooks/set-up/schedule-weekly-runs.md).

## If you use Claude Code

The `digest-cli` skill (in `.claude/skills/digest-cli`) walks through these steps and answers
"how do I..." questions by pointing at the right runbook.

## Related

- [All runbooks](../runbooks/README.md)
- [CLI commands](../reference/cli-commands.md)
