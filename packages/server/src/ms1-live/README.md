# MS1 live pairing

**Status:** implemented, fixture-validated on one machine · **Updated:** 2026-10-23 · Operator steps:
[MS1 live run](../../../../docs/operations/ms1-live-run.md) · Plan and hand-off:
[plan](../../../../docs/plans/lanes/MS1-live.plan.md), [hand-off](../../../../docs/plans/lanes/MS1-live.handoff.md).

An opt-in way for the production `start()` to be one half of a two-node MS1 run: a **home** whose relay inference runs on an
**executor** through F2-d ([remote attempts](../remote-attempts/README.md)), or that executor, with a llama-server **attached**
(never owned). `StartOptions.ms1Live` carries a parsed configuration; `bin.ts` and `ms1-live start` read it from
`GUANXI_MS1_LIVE_CONFIG`. Unset, no code in this directory runs and the boot is unchanged.

| File | Owns |
| --- | --- |
| `config.ts` | the strict JSON configuration, loopback-only URLs, error codes that name a field and never a value |
| `identity.ts` | Ed25519 identity, `init`, the public peer offer, key-file checks (mode 0600, belongs to the identity), pairing checks |
| `transport.ts` | the `FederationChannel` transport: one configured loopback origin, federation paths only, no redirect, a deadline |
| `boot.ts` | `Ms1LiveNode`: federation host options, connections ensured by name, home relay wiring (`RemoteRelayRuntime` into the existing `RelayRuntimeSource`), executor attestation, the optional K5/LW lead wiring |
| `checks.ts`, `preflight.ts`, `doctor.ts` | the explained diagnostics; stable codes, no key material |
| `cli.ts` | `init`, `doctor`, `preflight`, `start`; exit 0 ok, 1 failed, 2 usage or configuration |

Boundaries worth knowing:

- The configuration is validated, and the key read, **before** the database or any listener exists; a conflicting option, a non-loopback
  host, a world-readable key or a self-pairing is a boot error.
- **Two listeners per node.** The owner API (workspaces, projects, relay starts, connections) keeps its port and is never forwarded. A
  second, federation-only listener serves `/api/federation/*` behind the Host allowlist and answers everything else `404`: it is
  the only port the operator's ssh forward reaches. The main app does not mount federation in this mode.
- The federation plugin loads after K3 (an executor's dispatch needs a local-runtime connection) instead of at kernel boot, only under
  this option. The home asserts `alwaysOn` (R1 refuses remote attempts otherwise) and has no Ollama fallback: its model-inventory
  callback refuses.
- The executor serves under the federation identity's account; the home looks its connection up under the local owner.
- Scopes are exactly `attempts` plus `replicas` (the executor's relay-run pin is a replica-stream binding), trust `owner_device`, no
  admin right, on both identities: a peer file with more is refused.
- `connectionsPolicy` defaults to `{ ownerDevice: true, nodeKeyOptIn: true }` under this option (the relay's connection must be
  unattended); that is node-wide, each connection still needs its own consent.
