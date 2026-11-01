# Guanxi

> Early alpha. The architecture is being re-founded; see [status](#status).

**Guanxi** (关系, "connections") is an open-source, local-first agent harness that links every
model you can reach — subscriptions through their official agents, API keys, and local models
on any of your machines — with every machine you own. Strong models plan, cheap or free models
do the long work, and the harness improves from its own sessions under a benchmark gate.

Read the [vision](docs/vision/VISION.md) and the [requirements](docs/vision/REQUIREMENTS.md).

## Status

- **The running application combines the legacy workbench and merged re-foundation slices.**
  The own plugin kernel, session log, connections and encrypted vault, durable runs, federation
  base, design foundations and new web shell are in the repository. Native and external agents,
  the relay executor, repository indexing, approval signing and the benchmark foundation have
  merged implementations with explicitly tracked residuals. The connections centre supports
  API, local-runtime and agent connections; inference is no longer Ollama-only.
- **MS1 is closed on recorded two-node fault runs** (D-214, D-219), including one run completing
  all ten target items with zero lead tokens while asleep and exactly one wake. These are
  [dated hardware observations](docs/plans/evidence/ms1-fault-runs-2026-10-24.md), not a fresh
  test of every runtime. The full B3 benchmark remains an MS2 gate.
- **Wave 8 added a first macOS desktop shell, route authorization and a restricted queue-v3
  reader** (merged in [PR #4](https://github.com/MattoYuzuru/Guanxi/pull/4)). Desktop signing/distribution,
  accounts, the full plugin platform, phone control and self-evolution remain unfinished.
  Use [stage status](docs/plans/PHASE_STATUS.md) for implemented scope and evidence,
  [the next slice](docs/plans/NEXT_AGENT_PROMPT.md) for continuation and
  [the roadmap](docs/plans/ROADMAP.md) for target gates. The
  [legacy docs](docs/legacy/README.md) describe the retained Ollama workbench;
  [the target architecture](docs/architecture/TARGET_ARCHITECTURE.md) includes planned work.

## Current layout

```text
packages/contract  Zod REST/SSE schemas
packages/kernel    own plugin kernel and node host
packages/server    Hono API, SQLite, Ollama adapter, agent/tools
packages/ui        design tokens, fonts and UI foundations
packages/web       React SPA
packages/cli       foreground launcher (guanxi)
packages/desktop   Electron macOS shell and detached node service packaging
packages/bench     offline benchmark foundation and B3 cohort runner
```

Ollama runs as a separate process. Guanxi listens on loopback by default and stores data in
`~/.guanxi/guanxi.db`.

## Requirements

- Node.js 26.9.0 for the current development/CI setup (the server uses `node:sqlite`);
- npm;
- a configured model connection for inference (for example a running Ollama).

The package manifests still declare Node.js 22.5 as their minimum; the current hosted gate
uses 26.9.0 and does not establish compatibility across that whole range.

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

`npm test` runs the offline UI, codemod, core/CLI, kernel, web component and bench suites.
The mocked Chromium gate needs Chromium installed first: `npx playwright install chromium`
from `packages/web`. During development, run affected checks; final ready candidates require
the [hosted CI protocol](docs/operations/ci.md), including `npm run ci:finish -- PR --wait`.

## CLI

```bash
npm run link:cli
guanxi
```

The current CLI starts the server in the foreground and opens the browser.

## Documentation

Start at the [documentation map](docs/NAVIGATION.md). Key entry points:
[latest owner decisions](docs/decisions/2026-10-31-owner-decisions.md),
[ADR index](docs/decisions/README.md), [research](docs/research/README.md),
[roadmap](docs/plans/ROADMAP.md), [stage status](docs/plans/PHASE_STATUS.md).

## License

[Apache-2.0](LICENSE). Reused third-party work is listed in
[THIRD_PARTY_NOTICES](THIRD_PARTY_NOTICES.md); see also [NOTICE](NOTICE).
