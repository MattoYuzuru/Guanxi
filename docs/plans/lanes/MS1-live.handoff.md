# MS1-live — the production boot on two nodes: hand-off

**Status:** implemented and independently reviewed candidate; fixture-validated on one machine only (two real processes, a loopback
forward emulator, a fake llama-server). **Date:** 2026-10-23 · **Branch:** `claude/ms1-live-host`, lane clone
`/Users/yuzuru/Projects/Guanxi-lanes/ms1live`, base `0ab58729`, ports 5231/4431, Node 26.9, macOS only. No SSH, live model, paid call,
network beyond loopback, `~/.guanxi` or secret was used. `PHASE_STATUS.md` and `NEXT_AGENT_PROMPT.md` are untouched. No migration, no
contract change, no dependency, no third-party code. Plan: [MS1-live.plan.md](MS1-live.plan.md). Operator steps:
[MS1 live run](../../operations/ms1-live-run.md).

## What was built

The production `start()` can now be one half of the MS1 pairing from an opt-in configuration (`StartOptions.ms1Live`, read by `bin.ts`
and by `ms1-live start` from `GUANXI_MS1_LIVE_CONFIG`). Unset, the boot is unchanged (asserted). Code: `packages/server/src/ms1-live/`
([README](../../../packages/server/src/ms1-live/README.md)); entry `packages/server/scripts/ms1-live/ms1-live.ts`.

- **Home.** Federation node (`attempts` + `dispatch.channel`), the `ms1-executor` local-runtime connection (unattended) ensured by name,
  `RemoteRelayRuntime` handed to the **existing** `RelayRuntimeSource` as `observer`, an `OwnedCheckoutAllocator`, owner reserves. A relay
  started through `POST /api/relay` (or LW's `guanxi_delegate` through the same public start) runs every call on the executor. There is
  no Ollama path: the source's model-inventory callback refuses. `relay/start.ts` is untouched.
- **Executor.** `LlamaServerHost.create({kind: 'attach'})`, `dispatch.relayRuntime` = its runtime, a `localModel` attestation for the one
  configured model (a configuration assertion, labelled as such), a local-runtime connection under the federation account, warm-up of the
  GGUF hash at start.
- **Pairing.** `init` writes `node.key` (0600, `wx`, never replaced), a public `peer-offer.json` and a template; both identities are
  `owner_device`, not admin, with exactly the scopes `attempts` and `replicas`; keys are files, configuration names paths.
- **Two listeners.** The owner API is never forwarded. A federation-only listener (`/api/federation/*`, Host allowlist, `404` otherwise)
  is the only port the operator's `ssh -L/-R` reaches. The transport dials one configured loopback origin, follows no redirect, and has
  per-class deadlines (observe, count and offer: minutes; every other message 15 s).
- **Lead (optional `home.lead`).** K5 `claude-code` installation, LW `leads.relay` with the owner's `limits`, an allow-list of exactly the
  paired connection and model, `alwaysOn`; `start --lead-prompt-file F --project ID` starts at most one lead and prints the vendor sign-in
  command (paths only).
- **Commands.** `init`, `doctor`, `preflight` (`--completion` on the executor), `start`; `--json`; exit 0 ok, 1 failed, 2 usage or an
  unloadable configuration.

## Defaults I chose and recorded (owner asked for none)

1. Two listeners (review P1): `listen.federationPort` is required, `listen.port` is the owner API. Same port number on both ends of a forward.
2. `home.alwaysOn: true` is a required key of the home (R1 refuses `startRemote` without it; found by the first live run), not only of the lead.
3. Exact scopes `attempts` + `replicas`: `replicas` is required by the pin (`replicas.bind`), found by the first live run.
4. The executor's connection belongs to the federation account (`localChat` runs under it), the home's to the local owner.
5. `connectionsPolicy` defaults to unattended-capable under this option only (node-wide; each connection still needs its own consent).
6. Link timing defaults: holder TTL 30 s, safety 2 s, model age 60 s, reservation 120 s, observe/count/offer 15 min, other messages 15 s.
7. Template reserves for a 32768-token window: turn 4096, safety 512, handoff 3072, tool 3072, stepMedian 1536, effective 24000 (tested
   against `thresholds`; `preflight` re-checks against the observed window).
8. Default ports: owner API 4551/4552, federation 4561/4562. Node ids `ms1-<role>-<8 hex>`, account `owner`.

## What each test proves (45 new, `packages/server/test/ms1-live/`)

| File | Tests | Proves (and fails when violated) |
| --- | --- | --- |
| `config.test.ts` | 6 | strict schema; errors name a field, never a value (a pasted key is not echoed); only `http://` loopback with a port; lead needs all four caps, exact version, absolute binaries; env unset means plain boot; the template parses and its reserves fit 32768 |
| `identity.test.ts` | 4 | key 0600, no key in any other file or output; an identity is never replaced; key mode, foreign key, bad key, self-pairing, account, trust, missing/extra scopes, admin all refused |
| `transport.test.ts` | 4 | one origin, signed request unchanged; only `/api/federation/` paths; redirect, silence and refusal are errors; per-class deadlines |
| `doctor.test.ts` | 4 | each broken piece is named with a fix and exit 1 (key mode, peer file, account, scopes, ports, lead binaries, llama alias/health/loading/down); no key in output; exit-code and usage contract |
| `boot.test.ts` | 12 | plain boot has no federation, no connection, `404` handshake, stock refusal; every configuration error is raised before any file exists; home boots idempotently; one data directory, one identity; executor with no llama-server stays up and honest; `localModel` attests exactly one model and the home none; command exit codes; federation listener serves only the signed API and the owner API does not serve federation; occupied federation port releases everything; connection conflict and unattended policy refused; executor restart reuses its connection and **close does not wait for a model hash**; a failed lead setup closes the node |
| `live.test.ts` | 4 | two real `ms1-live start` processes: preflight proves the link both ways and prints model, window, build, digest, counter source, observation time; a relay through the public route runs every call on the executor (signed pin/unpin, one offer and grant per completion, child ledgers equal the evaluated tokens call for call, no pin left, checkout gone, project untouched, a tripwire on `OLLAMA_HOST` never asked anything, no key in output or any database); idempotent key and public stop; the forward carries federation only |
| `failures.test.ts` | 7 | wrong peer key, stranger at either end, executor down, dropped forward (and recovery without restart), llama-server down, wrong model, `evaluatedSkew` meter mismatch (`truncation_protocol`, nothing billed): each is refused or fails loudly with no run, session, checkout, completion or Ollama request |
| `lead.test.ts` | 4 | the fixture ACP lead delegates through the production boot, sleeps, the plan runs on the executor, one wake; a second start does not start a second lead; the owner's limits and allow-list refuse three briefs; a lead that cannot be set up fails the start |

`live-world.ts` is the harness: executor and home as real child processes, `Forward` (a TCP pipe `[::1]:P` to `127.0.0.1:P` that logs
federation requests and can be cut, the topology of `ssh -L P:127.0.0.1:P`), a tripwire Ollama, the fake llama-server from
`test/fixtures` and the rehearsal's `ms1Script`.

## Gates

Mac, Node 26.9.0, shared lock resource `heavy`. Receipts are filled in the final commit.

| Gate | Result |
| --- | --- |
| `npm run typecheck` | pending |
| `npm run lint:md`, `npm run check:licenses` | pending |
| `agent-dev … npm run test` | pending |
| `agent-dev … npm run build` | pending |

**New: 45** (config 6, identity 4, transport 4, doctor 4, boot 12, live 4, failures 7, lead 4). **Regression envelope:** the rest of the
core run. The K4 gate sandbox (Colima) was running; the lane did not start or reset it. `live`, `failures` and `lead` need it and fail at
once with a clear message otherwise.

## Independent verification

`sde-agent:implementation-reviewer` (read-only) reviewed `0ab58729..a8daa941`. **P1:** the `ssh -R/-L` forward exposed each node's whole
owner API (unsigned, loopback-guarded only) to every local user of the other host: fixed by the federation-only listener
(`c3d241e8`), with a test that the forwarded port serves nothing but the signed API and that the owner API serves no federation.
**P2:** shutdown of an executor waited for the whole GGUF hash (fixed, mutation-checked); a pairing accepted more scopes than claimed
(exact scopes, no admin, tested); `boot.test.ts` hung under an ambient `GUANXI_API_PORT` (the port is now explicit). **P3 fixed:**
failed lead setup leaving the node running, an unauthenticated handshake body, one 15-minute deadline for everything, peer text echoed
to the terminal, over-claiming titles, missing tests (conflicting options, `connection_conflict`, `model_invalid`, executor restart),
`--completion` ignored on a home, warm-up only in the CLI (now in `start()`), `init --id` validation, the `unattended_unavailable` error,
early-throw paths not closing the node, the Host/port topology not exercised (the forwarder is now a real same-port TCP pipe). **Noted,
not changed:** the attestation `observedAt` is "now" by construction (labelled; the real observation is the counted chain); negative
checks use bounded fixed sleeps (1.5 s) and ports come from bind-and-release (`freePort`); the `claude-code` provider needs a type cast
to create the connection; `counter || observer?.open` in `index.ts` also admits a trusted `relay` option that carries an observer but
no counter (it previously got the stock refusal): no existing caller does.

## Mutation evidence

A source mutation was applied, the named file run, the source restored. Caught: transport follows redirects; transport forwards any
path; any host accepted in configuration; key mode unchecked; key not tied to the identity; option conflict allowed; non-loopback host
allowed; pairing connection created in the plain boot; any executor allowed to a lead; federation listener serves the whole owner API;
federation also mounted on the owner API; extra scopes accepted; admin accepted; every message may take minutes; Host guard dropped on
the federation listener; relative lead paths accepted; lead failure leaves the node running; shutdown waits for the hash (4.5 s against a
2.5 s bound). Caught by a hang rather than a failure (the leaked listener keeps the test process alive): two of the above. Equivalent,
not asserted: replacing the home's no-Ollama model-inventory callback (the observer path never calls it; the tripwire shows nothing was asked).

## K5 readiness for Claude Code (read-only; nothing installed)

`packages/server/src/external-agents/profiles.ts` declares `claude-code` as ACP v1 with **no arguments**, source
`https://github.com/agentclientprotocol/claude-agent-acp`. What K5 does (`service.ts`, `process.ts`):

- It spawns `installation.executable` **directly**, argv `[]`, in a private working directory with an allow-listed environment
  (`PATH` = the Node directory, the bridge's directory, `/usr/bin:/bin`, the CLI's directory; `HOME`, `XDG_*`, `CLAUDE_CONFIG_DIR`
  private under `<data dir>/external-agent-config/<hash(node, owner, connection)>`). So `executable` is the **ACP bridge**, not `claude`.
- Before every run it runs `claudeExecutable auth status` and requires `loggedIn` with `authMethod === 'claude.ai'` (else
  `claude_login_required`); `CLAUDE_CODE_EXECUTABLE` for the bridge is that CLI's real path. `claudeBare: true` is refused for subscriptions.
- `version` must equal the bridge's ACP `agentInfo.version`; an absent `agentInfo` is "unknown", not a mismatch.
- On this Mac only the CLI exists: `~/.local/bin/claude` is a symlink to `~/.local/share/claude/versions/2.1.287` (`claude --version`
  prints `2.1.287`); there is no `claude-agent-acp` anywhere on `PATH` or in global npm. In an empty isolated config, `claude auth status`
  of 2.1.287 prints the JSON K5 parses (`loggedIn: false`, `authMethod: "none"`) with exit 1, which K5 accepts as "not logged in".
- **The login must be redone in the private config directory** (the everyday login is not used). `ms1-live start` prints the exact
  command (`lead-login`: the CLI path, `auth login`, the environment paths). On macOS the login keychain may not separate by
  `HOME`/`CLAUDE_CONFIG_DIR` (K5 README): untested.
- **Installing the bridge** (operator, not done here): npm package `@agentclientprotocol/claude-agent-acp` (the repository name above;
  the package name and its bin name are **not verified offline**: `npm view @agentclientprotocol/claude-agent-acp version bin` first).
  Suggested: `npm install --prefix ~/.guanxi-agents/claude-agent-acp @agentclientprotocol/claude-agent-acp@<exact version>`, set
  `home.lead.bridge` to the absolute path of the installed bin (its shebang finds `node` through K5's `PATH`), read its `agentInfo.version`
  by one `initialize` line on stdin, and put that exact value in `home.lead.bridgeVersion`. The test fixture's `0.94.0` is a reconstruction.
- **Model and effort (D-210 asks for Sonnet 5.5 at medium effort).** `home.lead.model` becomes the ACP role model: `default`, or a value
  of the bridge's *model* `configOptions` select (`session/new`), else `model_unavailable`; the value for Sonnet 5.5 is not known
  offline. K5 refuses `params.reasoning` for Claude Code (`service.ts`: `unsupported_parameter`) and the ACP client has no reasoning
  option, so medium effort **cannot be requested through the role binding**: it must come from the CLI's settings in the private config
  directory, or from an owner-approved K5 change. Not decided or tested here.
- Unverified: `session/cancel`, `session/load`, `mcpCapabilities.http` and the billing of the real bridge (LW residuals); whether the
  vendor treats subscription use through a third-party ACP bridge as extra usage (research report 01, D-190).

## Operator runbook (summary; full text in the [runbook](../../operations/ms1-live-run.md))

1. Fedora: llama-server `--alias <model> --host 127.0.0.1 --port 8090 -c 32768 -np 1 --jinja --no-context-shift --no-webui`.
2. Both: `ms1-live init --role home|executor --dir D [--model M] [--llama-url U]`; copy each side's **public** `peer-offer.json` to the
   other as `peer.json`; edit `ms1-live.json` (model, reserves, optional `home.lead`).
3. Both: `ms1-live doctor --config …` and fix every FAIL line.
4. Fedora: `ms1-live start --config … --data-dir …`; wait for `{"event":"warm","state":"ready"}` (hashes the GGUF).
5. Mac: `ssh -N -o ExitOnForwardFailure=yes -L 127.0.0.1:4562:127.0.0.1:4562 -R 127.0.0.1:4561:127.0.0.1:4561 fedora` (federation ports only,
   same number on both ends); Colima up.
6. Mac: `caffeinate -dimsu ms1-live start --config … --data-dir …`.
7. Mac `ms1-live preflight`, then Fedora `ms1-live preflight --completion` (the first one-token real generation).
8. Mac: register the target clone (`POST /api/workspaces`, `/api/projects`, `PATCH /api/agent/projects/:id/roots`).
9. Run: `relay exec --url http://127.0.0.1:4551 --request plan.json`, or sign in the lead and `start … --lead-prompt-file F --project ID`.
10. Stop: public stop, Ctrl-C the home, the forward, the executor. A relay run does not survive its node.

## Residual risks (named, not closed)

1. **No SSH link, second machine or real end-to-end run.** After this branch was cut, main recorded the first real llama-server runs
   ([evidence](../evidence/fedora-real-runtime-2026-10-23.md)): the raw protocol and the R2-op classes in attach mode on the real b11496
   server agree (R2-op residual 1 closed for that build; the first hash took 7.5 s; about 5.2 to 5.6 tokens/s). This lane's tests still
   use the fixture server, and the two-node path over a real forward is untested; `preflight --completion` re-checks the real server
   from the executor's own process. The Fedora unit's alias is `qwen3.8-27b-iq3s` (the `init` default now). Attach cannot see shards,
   `--mmproj` or draft models, nor verify `--jinja` beyond the template round trip; `doctor` checks that the model file is readable by
   the node's user (attach hashes it locally).
2. **The Mac must not sleep.** `alwaysOn` is an assertion; leases run on a clock that does not count suspend. Nothing here arranges power.
3. **Stale pins** after a crash or an unreachable unpin are not reaped (`claude/stale-pin-reaping`); `maxPinsPerPeer` is 16.
4. **No judge for a remote relay** (`claude/remote-relay-judge`): R3's gates cannot be claimed for MS1 yet. The public start still builds
   no judge.
5. **A relay does not survive its node** (ADR-0020): a restart ends it `interrupted`; the lead must re-delegate.
6. **Trust boundary.** Both hosts must be single-user: a local user of the executor can reach the forwarded home federation port (signed
   API only: unsigned requests get `401`) and the executor's own loopback ports. TLS is not used; the ssh link is the private
   authenticated link F1 asks for.
7. **The real lead is untested:** bridge name and version, the sign-in in the private config directory, the macOS keychain, billing.
8. A single `ms1-live start` runs one lead start per invocation and cannot resume or cancel a lead (no HTTP surface, LW); stopping the
   home interrupts it.
9. Test hygiene: fixed 1.5 s windows for "nothing follows" checks, `freePort` races, Colima required, about a minute for each of the three
   process-based files when the machine is idle.

## Shared edits

`packages/server/src/index.ts` (the `ms1Live` option, the federation-only listener, `abortStart` factored from one catch block, the
`RelayRuntimeSource` condition `counter || observer?.open`, the returned `ms1Live`), `src/bin.ts`, `package.json` (script `ms1-live`),
`docs/NAVIGATION.md` (one row). Everything else is new: `src/ms1-live/`, `scripts/ms1-live/`, `test/ms1-live/`, the runbook, this file and
the plan. `relay/start.ts`, `relay/plugin.ts` and every federation, dispatch and runtime file are untouched.

## Next slice

Install the ACP bridge and the first real run, in this order: Fedora `ms1-live start` + `preflight --completion` against the real
llama-server; the two-host `preflight`; a one-item relay through `relay exec`; the lead with a one-item plan; then the six-hour run
(R3/B3 evidence needs the judge and the stale-pin reaper first). Merge the three parallel lanes (`remote-relay-judge`,
`stale-pin-reaping`, `r3-observation-journal`) and rerun `test/ms1-live` and `test/ms1` on the union.
