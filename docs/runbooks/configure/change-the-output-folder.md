# Change the output folder

Part of [Runbooks](../README.md) / [Configure](README.md).

## Purpose

Choose the folder where the finished digest files are written: `<week>.md` and `<week>.html`
(and `<week>.failed.md` after a failed run). The file channel is always on.

## When to use

- The digests should land in a shared or synced folder, or in a different place on the host.
- In Docker you want them somewhere other than the default mount.
- To send the digest somewhere else, use [Set up email](set-up-email.md) or
  [Set up Slack](set-up-slack.md). To write one digest elsewhere once, use `--out` (see below).

## Prerequisites

- The target folder exists, or its nearest existing parent is writable. A run creates the rest.
- Write access to `digest.config.json`.

## Steps

1. Pick the path. A relative path is read from the folder you run `digest` in; a host timer uses
   the working directory set in its file. An absolute path avoids doubt. The default is
   `dist/digests`. In Docker only two paths survive the container: the default (it is mounted from
   `./data/digests` on the host) and `data/digests`, which is the same folder.
2. Edit `digest.config.json`.

   ```json
   {
     "delivery": {
       "markdown": { "dir": "/srv/team/digests" }
     }
   }
   ```

   The value must not be empty.

3. Apply the change. `digest serve` reads the config once, at start. In Docker:
   `docker compose restart digest`. A manual `pnpm digest run` and a host timer read the file
   again each time. In Docker, other commands are `docker compose run --rm digest <command>`.
4. Optional: move the old files. Nothing moves them for you.

   ```bash
   mv dist/digests/* /srv/team/digests/
   ```

5. Run the check.

   ```bash
   pnpm digest doctor
   ```

For one run only, `pnpm digest run --out <dir>` overrides the folder and leaves the config alone.

## Verify

- Doctor prints the folder it will use:

  ```text
  ✓ markdown: digests are written to /srv/team/digests
  ```

  If the folder is missing but its parent is writable, the line says a run creates it.

- After the next run, its summary has a `Markdown` line with the file path, and
  `/srv/team/digests/<week>.md` exists. A dry run writes there too.

## Roll back

Set `dir` back to `dist/digests` (or delete the key) and restart as in step 3. Files already
written stay where they are.

## Troubleshooting

| Symptom                                                                        | Cause                                   | Fix                                                   |
| ------------------------------------------------------------------------------ | --------------------------------------- | ----------------------------------------------------- |
| `✗ markdown: ... is a file, not a folder`                                      | A file sits at that path                | Remove it or choose another path                      |
| `✗ markdown: cannot write to <folder>`                                         | No permission                           | `chmod u+w` as the `fix:` line says, or choose a path |
| `Too small: expected string to have >=1 characters` at `delivery.markdown.dir` | Empty string                            | Give a path or delete the key                         |
| Files vanish in Docker                                                         | The path is inside the container        | Use the default or `data/digests`                     |
| `digest show <week>` still works but the folder is empty                       | Show reads run records, not this folder | Look in `data/runs/<week>/digest.md`                  |

## Related

- [Markdown delivery](../../configuration/delivery-markdown.md), [Files and paths](../../reference/files-and-paths.md)
- `dataDir` holds run records and the lock; it is not this setting. A new `dataDir` starts with
  no history, so already sent items could come back.
- [src/delivery/CLAUDE.md](../../../src/delivery/CLAUDE.md)
