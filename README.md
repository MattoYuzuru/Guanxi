# Guanxi

> Early alpha. The architecture is being re-founded; see [status](#status).

**Guanxi** (关系, "connections") is an open-source, local-first agent harness that links every
model you can reach — subscriptions through their official agents, API keys, and local models
on any of your machines — with every machine you own. Strong models plan, cheap or free models
do the long work, and the harness improves from its own sessions under a benchmark gate.

Read the [vision](docs/vision/VISION.md) and the [requirements](docs/vision/REQUIREMENTS.md).

## Status

- **What runs today** is the Alamo-era code (the project's previous name): a local web UI and
  server over Ollama with durable chat jobs (replay, cancel, restart recovery), a resource
  governor, sourced capability and fit evidence, a Hugging Face/Ollama catalog, logical
  projects, retention, attachments and English/Russian UI. Its documentation is in
  [`docs/legacy/`](docs/legacy/README.md).
- **What comes next** is a re-foundation on an own plugin kernel (Cordis 4) with native and
  external agents, a multi-machine fleet, relay executors for small local models, a benchmark
  stage and a self-evolution loop. See the [target architecture](docs/architecture/TARGET_ARCHITECTURE.md)
  and the [roadmap](docs/plans/ROADMAP.md). None of it is implemented yet.

## Current layout

```text
packages/contract  Zod REST/SSE schemas
packages/server    Hono API, SQLite, Ollama adapter, agent/tools
packages/web       React SPA
packages/cli       foreground launcher (guanxi)
```

Ollama runs as a separate process. Guanxi listens on loopback by default and stores data in
`~/.guanxi/guanxi.db`.

## Requirements

- Node.js 22.5 or newer (the server uses `node:sqlite`);
- npm;
- a running Ollama for inference.

## Development

```bash
npm install
npm run dev:server
```

The server listens on `http://127.0.0.1:4310`. For a separate Vite dev server:

```bash
npm run dev:web
```

It opens on `http://127.0.0.1:5173` and proxies the API to port 4310.

## Checks

```bash
npm run typecheck
npm test
npm run test:web:browser
npm run build
npm run lint:md
npm run check:licenses
```

`npm test` runs core, CLI and web component tests. The mocked Chromium gate needs Chromium
installed first: `npx playwright install chromium` from `packages/web`.

## CLI

```bash
npm run link:cli
guanxi
```

The current CLI starts the server in the foreground and opens the browser.

## Documentation

Start at the [documentation map](docs/NAVIGATION.md). Key entry points:
[owner decisions](docs/decisions/2026-10-19-owner-decisions.md),
[ADR index](docs/decisions/README.md), [research](docs/research/README.md),
[roadmap](docs/plans/ROADMAP.md), [stage status](docs/plans/PHASE_STATUS.md).

## License

[Apache-2.0](LICENSE). Reused third-party work is listed in
[THIRD_PARTY_NOTICES](THIRD_PARTY_NOTICES.md); see also [NOTICE](NOTICE).
