# Run

Part of [Runbooks](../README.md).

Start the pipeline on demand, test it without sending, or look at its parts one at a time.

| Runbook                                     | Use it to                                                                      |
| ------------------------------------------- | ------------------------------------------------------------------------------ |
| [Run now](run-now.md)                       | Make and deliver this week's digest immediately                                |
| [Dry run](dry-run.md)                       | Run the whole pipeline and write the digest to disk while sending nothing      |
| [Force a week](force-a-week.md)             | Run a week that is already `sent` again from scratch, with `--force`           |
| [Run evals](run-evals.md)                   | Replay the recorded weeks and cases and get a scorecard (light takes ~110 min) |
| [Preview a week](preview-a-week.md)         | Render a saved run as Markdown, email and Slack files, without sending         |
| [Fetch sources only](fetch-sources-only.md) | Fetch the feeds with no models and save the raw and parsed data for debugging  |
