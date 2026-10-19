# Doctor folder checks

## Intent

Answers one question for each folder a run writes into (`dataDir`, and `delivery.markdown.dir` when
it is set): can a run write here, or create it? It tells a missing folder that a run can create from one that it cannot.

## How it works

1. `dataDirCheck(dir)` and `markdownDirCheck(dir)` build a `DirCheck`: the absolute path, the
   label, the config key that moves it and the wording for "writable" and "creatable".
2. `checkWritableDir(spec, io)` calls `inspectDir(dir, setting, io)` and turns the status into a
   result: ok (writable or creatable) or an error with a fix.
3. `inspectDir` walks up from `dir`. `pathKind` says what each path is: `folder`, `file`,
   `dangling` (a symbolic link to nothing) or `missing`. The first existing folder is tested with
   `access`. `dir` itself: `writable`. A parent: `creatable`, naming that parent.
4. A file in the way (at `dir` or above it), a dangling link, a folder that is not writable, a path
   that cannot be inspected, or no existing parent at all: `blocked`, with a problem and a fix.

## Design

- Symbolic links are followed with `stat`, and told apart with `lstat`. `ENOENT` and `ENOTDIR`
  from `lstat` both mean missing; climbing on finds the file that causes `ENOTDIR`.
- A relative path is resolved against the working directory when the check is built.
- The fix names the config key, so the user knows what to change.
- All disk access goes through the `stat`, `lstat` and `access` of `DoctorIo`.

## Files

| File                  | Role                                                                      |
| --------------------- | ------------------------------------------------------------------------- |
| `writableDir.ts`      | `DirCheck`, `dataDirCheck`, `markdownDirCheck`, `checkWritableDir`        |
| `inspectDir.ts`       | `inspectDir`, `pathKind`, `DirStatus`, `PathKind`, `DirIo`                |
| `writableDir.test.ts` | The builders, plus data and markdown folder cases through `doctorCommand` |
| `inspectDir.test.ts`  | Every status and path kind on a fake disk                                 |

## Depends on, used by

Depends on: `report/checkResult`, `errorCode.ts`, `types.ts`, `shared/errors`.
Used by: `doctor.ts` (data folder) and `checks/delivery.ts` (markdown folder, only when `delivery.markdown.dir` is set).

## Change it safely

- Run `pnpm vitest run src/cli/doctor/folders`. `../doctor.fs.test.ts` runs the main cases on a
  real temporary folder.
- A run creates a missing folder with `mkdir`, so a file or a dangling link in the way must stay an
  error here.
