# Engineering Digest Agent

A local-first agent that writes a weekly digest of the 3-5 AI and platform engineering
releases that matter. It runs end to end on [Ollama](https://ollama.com) at zero cost.

> Status: under construction (pre v0.1.0). Install and usage docs land with the first release.

## Development

```bash
pnpm install
pnpm check        # typecheck, lint, unit tests
pnpm digest --help
```

Requires Node 24 or later and pnpm. Models are pulled from Ollama; this repo ships model tags only.

## License

MIT
