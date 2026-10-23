# MS1-live — the production boot on two real nodes: plan

**Status:** plan · **Date:** 2026-10-23 · **Branch:** `claude/ms1-live-host` (lane clone `Guanxi-lanes/ms1live`, base `0ab58729`,
ports 5231/4431, Node 26, Mac) · Owner decisions: D-196 (Fedora real runs), D-197 (Claude Code lead), D-198 (target repo).

## Outcome

The MS1 rehearsal hand-composes `RelayStore`, `RelayStarts`, `RemoteRelayRuntime` and the lead plugin. This slice makes the
**production** `start()` able to be the home node (relay inference on an executor through F2-d) or the executor node (F2-d
relay runtime over a `LlamaServerRuntime` in attach mode), from an opt-in configuration, plus operator commands and a runbook.
Nothing runs against a real model, SSH or network in this lane: fixtures and loopback only.

Non-goals: judge for remote relays (`claude/remote-relay-judge`), stale pin reaping (`claude/stale-pin-reaping`), the R3
journal, TLS, an SSH launcher, any install. No change to defaults: without the option `start()` is byte-for-byte today's boot.

## Design

1. **Config** (`src/ms1-live/config.ts`). One strict JSON file, named by `GUANXI_MS1_LIVE_CONFIG` (read by `bin.ts` and the
   `ms1-live start` command) or passed as `StartOptions.ms1Live` (already parsed). Role `home` | `executor`. It names *files*, never
   values: `identityFile`, `privateKeyFile` (must be mode 0600), `peerFile` (the other node's public identity), plus the peer's loopback
   URL, the model, the llama-server attach URL (executor), reserves, dispatch timing and, optionally, a `lead` section. Relative
   paths resolve against the config file. Every URL must be `http://` loopback with an explicit port.
2. **Identity** (`identity.ts`). `init` makes an Ed25519 key pair, writes `node.key` (0600), `identity.json`, a public
   `peer-offer.json` to copy to the other node, and a config template. Scopes are the minimum: `attempts`. Both nodes use one account
   id (`--account`, default `owner`), trust `owner_device`, not admin. Never overwrites a key.
3. **Transport** (`transport.ts`). The `FederationChannel` transport: `fetch` to the peer's configured loopback origin, `redirect:
   error`, timeout, no other host ever. The operator's SSH `-L`/`-R` forwards are the private authenticated link F1 requires. The
   server's Host allowlist checks the node's own port, so each side forwards the **same port number** it listens on.
4. **Boot** (`boot.ts`, one narrow block in `index.ts`). With `ms1Live` the federation plugin loads after connections (the executor's
   dispatch needs K3) instead of at kernel boot. Home: ensure the `ms1-executor` local-runtime connection (unattended), build
   `RemoteRelayRuntime`, hand `RelayRuntimePolicy.observer` to the existing `RelayRuntimeSource` and an `OwnedCheckoutAllocator` to the
   existing relay plugin host (no change to `relay/start.ts`). Executor: `LlamaServerHost.create({kind: 'attach'})`, ensure a
   local-runtime connection, `dispatch.relayRuntime = host.runtime`, `localModel` for the one configured model. `connectionsPolicy`
   defaults to unattended-capable only under this option. Conflicts with `federation`, `relay`, `operationalRelay` are boot errors
   raised before any file exists. Optional `lead` (home): K5 `claude-code` installation, `leads.relay` with the owner's `limits` and a
   `validateExecutor` that admits only the configured connection and model, `alwaysOn: true` asserted in the file.
5. **Failure is loud.** A missing/foreign peer key, an unreachable peer, an unreachable llama-server or a counter mismatch ends in a
   relay refusal (`runtime_meter_unavailable`, `runtime_identity_unknown`, `truncation_protocol`, ...) and never in local inference:
   the home has no Ollama path in this mode (`RelayRuntimeSource` models callback throws) and its start refuses.
6. **Commands** (`src/ms1-live/cli.ts`, entry `scripts/ms1-live/ms1-live.ts`): `init`, `doctor`, `preflight`, `start`. All
   non-interactive, `--json`, exit 0 ok / 1 check failed / 2 usage or config error. `preflight` (home) sends a signed observe and a
   signed exact count of the fixed probe through the executor; (executor) checks the local llama-server through the same runtime
   class and the reverse link by a signed handshake to the home. It prints model, digest, window, build, counter source and
   observation time. `doctor` explains each missing piece with a fix. No key text is ever printed.

## Tests (fixtures only, no live model, no SSH)

- `test/ms1-live/config.test.ts`, `identity.test.ts`, `transport.test.ts`: unit properties (strict config, 0600 key, loopback only,
  no overwrite, no secret in output).
- `test/ms1-live/live.test.ts`: two child processes running the real `ms1-live start` (separate data dirs, loopback ports) plus the
  fake llama-server in attach mode: preflight passes; a relay started through `POST /api/relay` runs every call on the executor
  (counts, pins, one grant per completion, child ledgers equal evaluated tokens, no Ollama); the same through the ACP fixture lead and
  `guanxi_delegate`; misconfigurations (wrong peer key, executor down, llama-server down, `evaluatedSkew`) fail with no local fallback
  and no `/completion` anywhere; the unconfigured `start()` has no federation routes, no `ms1-` connection and the stock refusal.
- Mutations recorded in the hand-off for the properties above.

## Risks

Federation late-load changes plugin order only under the option. The executor hashes the GGUF on first observe (minutes for 11 GB):
the transport timeout is configuration, and preflight warms it. Host allowlist forces same-port forwards. A relay does not survive a
node restart (ADR-0020); the lead must be told. The Mac must stay awake while a lead sleeps (`caffeinate`), asserted by `alwaysOn`.

## Gates

`npm run typecheck`, `lint:md`, `check:licenses`; `agent-dev … npm run test` and `npm run build` through the shared lock; targeted
`node --test` during iteration. K4 gate sandbox needs Colima (running at the time of writing); not started or reset by this lane.
