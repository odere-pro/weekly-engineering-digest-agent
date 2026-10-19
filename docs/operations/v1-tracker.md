# v1.0 tracker

Part of [Operations](README.md).

v1.0 is declared after four Mondays in a row delivered on time with every gate green and no
manual fix. Any manual fix resets the count to zero.

One row per scheduled Monday run. Fill it from `digest history` and the run folder
(`data/runs/<week>/run.json`).

| Date (Monday) | ISO week | Run status | Duration | Manual intervention | Clean streak |
| ------------- | -------- | ---------- | -------- | ------------------- | ------------ |

Columns:

- **Run status**: `sent`, `quiet`, `blocked`, `failed` or `skipped`, as recorded in `run.json`.
- **Duration**: wall-clock time of the run, from `run.json`.
- **Manual intervention**: `none`, or what was done by hand (restart, config edit, model pull, resend). Anything but `none` resets the streak.
- **Clean streak**: consecutive clean Mondays so far. v1.0 at 4.
