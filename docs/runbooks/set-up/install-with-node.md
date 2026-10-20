# Install with Node

Part of [Runbooks](../README.md) / Set up.

## Purpose

Run the `digest` CLI from a clone, with Ollama on the same machine. You end with a working
`digest.config.json` and `.env` in the clone folder.

## When to use

- You run from source, or on a Mac without Docker. Ollama then uses the Apple GPU directly.
- Use [Install with Docker Compose](install-with-compose.md) if you want a service that restarts.

## Prerequisites

- Node 24 or newer: `node --version`. pnpm: the version is pinned in `package.json`
  (`packageManager`). Install pnpm from pnpm.io, or enable Corepack if your Node ships it.
- Ollama 0.40.0 or newer on this machine (0.35.1 for the non-Apple fallback set).
- Set `OLLAMA_MAX_LOADED_MODELS=1` in Ollama's environment and restart it. The steps run one model
  at a time. Use Ollama's own documentation for how your install reads environment variables.
- Git. The package is not on npm, so you install from a clone.

The package is not published to npm, so commands run as `pnpm digest <command>`. After
`pnpm build` you can also run `node dist/artifacts/cli.js <command>`.

## Steps

1. Clone the repo and enter the folder.

   ```bash
   git clone https://github.com/odere-pro/weekly-engineering-digest-agent.git
   cd weekly-engineering-digest-agent
   ```

2. Install the dependencies exactly as locked.

   ```bash
   pnpm install --frozen-lockfile
   ```

3. Create the config. `init` asks for focus areas, a model profile, the time zone and where to
   deliver the digest. "Save locally" is ticked and always on: it shows the folder this week's
   files go to, `dist/<monday>/digest/` below the folder you run from. Email and Slack are extras
   you can tick. `init` writes `digest.config.json` and `.env` (mode 600) in this folder. It
   recommends `light`. At the end it prints the folder again and an OS schedule snippet. Save the
   snippet only if you will use it: see [schedule weekly runs](schedule-weekly-runs.md).

   ```bash
   pnpm digest init
   ```

4. Pull the models of your profile with `ollama pull <tag>`:
   [choose a profile and pull models](choose-profile-and-pull-models.md).
5. Check everything. Every line must start with a check mark, or with `!` for a warning you accept.

   ```bash
   pnpm digest doctor
   ```

6. Optional: build the single-file CLI. It lands in `dist/artifacts/cli.js`.

   ```bash
   pnpm build
   ```

7. Do a [first run](first-run.md).

## Verify

- `pnpm digest --help` lists `init`, `doctor`, `run`, `eval`, `fetch`, `show`, `preview`,
  `history`, `feedback` and `serve`.
- `pnpm digest doctor` prints a check mark (`✓`) for `config`, `ollama` and each model, and exits 0.
- `digest.config.json` and `.env` exist, and `.env` is readable only by you.

## Roll back

Nothing outside the folder was installed. To remove it, delete the clone (it holds `dist/`
and your config). Remove any OS schedule you saved
([schedule weekly runs](schedule-weekly-runs.md#roll-back)). To free the models, see
[prune disk](../maintain/prune-disk.md).

## Troubleshooting

| Symptom                                                    | Cause                                           | Fix                                                                             |
| ---------------------------------------------------------- | ----------------------------------------------- | ------------------------------------------------------------------------------- |
| `pnpm: command not found`                                  | pnpm is not installed                           | Install pnpm, then repeat step 2.                                               |
| `node --version` shows less than v24                       | The project needs Node 24 or newer              | Install a newer Node.                                                           |
| `No digest.config.json found ... Run "digest init" first.` | You are in the wrong folder, or skipped `init`  | `cd` to the clone, or run `pnpm digest init`. Use `-c <path>` for another file. |
| `Refusing to overwrite digest.config.json with --yes`      | A config with content already exists            | Move it away, or run `init` without `--yes` and confirm.                        |
| `doctor`: `ollama: ... no answer`                          | Ollama is not running, or `OLLAMA_URL` is wrong | Start Ollama (`ollama serve`). The default URL is `http://localhost:11434`.     |
| `doctor`: `model <tag>: not installed`                     | The model was never pulled                      | Run the `ollama pull` line that `doctor` prints under `fix:`.                   |

## Related

- [First run](first-run.md), [Choose a profile and pull models](choose-profile-and-pull-models.md)
- [CLI commands](../../reference/cli-commands.md), [Config keys](../../reference/config-keys.md)
- [Cost and hardware](../../overview/cost-and-hardware.md)
- Later, to move to a newer version: [Upgrade the tool](../maintain/upgrade-the-tool.md)
