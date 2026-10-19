# Set up

Part of [Runbooks](../README.md).

Install the tool, pick models, prove it works and put it on a schedule. Do them in this order the
first time.

| Runbook                                                               | Use it to                                                                     |
| --------------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| [Install with Docker Compose](install-with-compose.md)                | Run the weekly scheduler as a container on a Mac or a Linux box               |
| [Install with Node](install-with-node.md)                             | Run the CLI from a clone with Node 24 or newer and Ollama on the same machine |
| [Choose a profile and pull models](choose-profile-and-pull-models.md) | Pick `light`, `fast` or `quality` for this machine and pull its Ollama models |
| [First run](first-run.md)                                             | Check the install with `digest doctor` and a dry run that sends nothing       |
| [Schedule weekly runs](schedule-weekly-runs.md)                       | Start `digest serve` or save a launchd, systemd or `schtasks` timer           |
