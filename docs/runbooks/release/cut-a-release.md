# Cut a release

Part of [Runbooks](../README.md) / Release.

## Purpose

Mark a version: a green build, an updated changelog, one signed release commit and a signed tag.
There is nothing to publish. The package is not on npm or GHCR; people install from a clone.

## When to use

- You have merged work that users should be able to pin to, such as the fixes under
  `[Unreleased]` in `CHANGELOG.md`.
- To refresh the quality numbers first, use [Re-baseline evals](../maintain/re-baseline-evals.md).

## Prerequisites

- You are the maintainer. Agents commit locally but never push. You push the commit and the tag.
- Commits are signed through your SSH key (1Password agent unlocked), conventional, with a subject
  of 72 characters or fewer. The `commit-msg` hook rejects AI attribution lines.
- Docker running, for `docker/validate.sh`. The checkout is clean and on `main`, up to date.
- The last version is the tag `v0.1.0` (`git tag`). `package.json` says `0.1.0`.

## Steps

1. Run the same gates as CI (`.github/workflows/ci.yml`: `format:check`, `typecheck`, `lint`,
   `coverage` with 80% thresholds, `build`, `pnpm audit`, an image scan).

   ```bash
   pnpm install --frozen-lockfile && pnpm check && pnpm coverage && pnpm build
   ```

   ```bash
   pnpm audit --prod --audit-level high && docker/validate.sh
   ```

2. Choose the version `X.Y.Z` (Semantic Versioning, as `CHANGELOG.md` states).
3. Edit `CHANGELOG.md` (Keep a Changelog). Turn the `[Unreleased]` notes into
   `## [X.Y.Z] - YYYY-MM-DD`, leave a new empty `## [Unreleased]` above it, check that
   "Known limits" is true today, and fix the two links at the bottom:
   `[Unreleased]: .../compare/vX.Y.Z...HEAD` and `[X.Y.Z]: .../releases/tag/vX.Y.Z`.
4. Bump `version` in `package.json`. Update the places that name it: the status section of
   `README.md` ("This is v0.1.0 plus fixes") and [status and limits](../../overview/status-and-limits.md).
5. Commit with a subject like the last release commit.

   ```bash
   git add CHANGELOG.md package.json README.md docs/overview/status-and-limits.md
   git commit -m "chore(release): vX.Y.Z"
   ```

6. Create a signed, annotated tag, as `v0.1.0` is.

   ```bash
   git tag -s vX.Y.Z -m "vX.Y.Z"
   ```

7. Check both signatures before you push.

   ```bash
   git log -1 --format='%H %G? %s' && git verify-tag vX.Y.Z
   ```

8. Push the commit, then the tag by name. CI runs on pushes to `main` and on pull requests only,
   so wait for the run on the pushed commit: `check` on Node 24 and 26, and `image-scan`.

   ```bash
   git push origin main && git push origin vX.Y.Z
   ```

## Verify

- `git log -1 --format='%G?'` prints `G`, and `git tag -n1 -l vX.Y.Z` shows the tag.
- `git ls-remote --tags origin vX.Y.Z` lists it on the remote.
- Both CI jobs are green on the release commit.
- The compare link for `[Unreleased]` starts at the new tag.

## Roll back

Before you push: `git tag -d vX.Y.Z`, then undo the commit with `git reset --soft HEAD~1`.
After you push: do not move a published tag. Fix forward with the next patch version. Only if
nobody has fetched it, delete the tag with `git push origin --delete vX.Y.Z` and `git tag -d vX.Y.Z`.

## Troubleshooting

| Symptom                                           | Cause                                              | Fix                                                                                                                                                                                                                                |
| ------------------------------------------------- | -------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `pnpm format:check` fails                         | A file is not formatted                            | `pnpm format`, review, commit.                                                                                                                                                                                                     |
| `pnpm coverage` fails on a threshold              | Under 80% lines, functions, branches or statements | Add tests (`vitest.config.ts` holds the thresholds).                                                                                                                                                                               |
| `pnpm audit` reports a high advisory              | A production dependency is vulnerable              | Upgrade it on `main` and update the lockfile.                                                                                                                                                                                      |
| `image-scan` fails (Trivy, HIGH or CRITICAL)      | A fixed CVE in Node or a production dependency     | Node: bump the pinned `NODE_IMAGE` digest in the `Dockerfile` (see its comment). A package under `opt/eng-digest`: upgrade it and the lockfile. Debian fixes come in at build (`apt-get upgrade`); CVEs with no fix are not gated. |
| `docker/validate.sh` prints `FAIL: ...`           | Compose, image or model list drifted               | Read the message; `pull-models.sh` must match `src/config/profiles.ts`.                                                                                                                                                            |
| The commit or tag is not signed, or signing fails | The 1Password SSH agent is locked                  | Unlock it and retry. Do not pass `--no-gpg-sign`.                                                                                                                                                                                  |
| `commit-msg: AI attribution ... is not allowed.`  | A trailer names a tool                             | Remove the line from the message.                                                                                                                                                                                                  |
| `fatal: tag 'vX.Y.Z' already exists`              | The tag was made earlier                           | `git tag -d vX.Y.Z` if unpushed, otherwise pick the next version.                                                                                                                                                                  |

## Related

- [Re-baseline evals](../maintain/re-baseline-evals.md), [Status and limits](../../overview/status-and-limits.md)
- [CHANGELOG.md](../../../CHANGELOG.md), [CI workflow](../../../.github/workflows/ci.yml)
- [CLAUDE.md](../../../CLAUDE.md) (git rules), [docker/validate.sh](../../../docker/validate.sh)
