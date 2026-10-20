# Model access (K3)

**Status:** implemented consumer layer; locally validated with fixture services · **Updated:** 2026-10-20

`guanxi.connections` is a T0 kernel plugin requiring `egress.scrubber`, `ollama` and
`governor`. It provides `connections.registry` (`Connections`) and
`connections.egress-readiness` (`ready`, `assertReady()`); its vault is private.
`start()` loads it after the legacy context. This slice does not reroute the
legacy Chat or plaintext legacy search settings; K4 consumes the new model boundary and K5
executes the registered subscription CLIs. Search and STT are service connection roles.

## Boundaries

- The contract in `@guanxi/contract` defines kinds, supported routes, facts, balances,
  references, usage receipts and settings responses. Clients only receive references.
- The registry, ledger and vault use `connections.sqlite` next to the node database. K3's
  migration version table is independent of legacy `user_version`. Version 1 creates new
  tables; never rewrite it after distribution. Removing the plugin leaves this database
  and OS wrapping keys intact. Back up both; losing the wrapping key loses the vault.
- Each account has an AES-256-GCM data key wrapped with an OS-keychain key through
  `@napi-rs/keyring` 2.1.2. Account/ref additional authenticated data prevents moving
  ciphertext between identities. At plugin apply, all historical secrets are decrypted only
  for scrubber registration; this may prompt the OS keychain but never opens an injection
  session. Explicit unlock and unattended dispatch also access the keychain. Empty vaults
  require no boot-time keychain read. Tests use injected throwaway key stores.
- Interactive access requires an unlocked vault. The `unattended` flag is false by default;
  background access also requires both `ownerDevice` and `nodeKeyOptIn` in the immutable
  plugin policy (`StartOptions.connectionsPolicy` for the legacy boot). A node-key unlock
  does not open an interactive session. No HTTP request can enable the node opt-in.
- The known secret registry remains populated when an interactive vault is locked, so old
  tool output is still redacted. Rotation retains old records for that purpose. Plugin
  unload unregisters them; the next activation registers them during apply, exposing false readiness and refusing
  model/artifact egress if registration fails. Buffers are cleared where possible; JavaScript string erasure is not a
  guarantee.
- `complete()` selects an immutable pi-ai catalog model, scrubs the complete context,
  injects the vault key at dispatch, scrubs the full response and records usage. It exposes
  no login API, arbitrary headers, base URL override or environment credential fallback.
  Anthropic OAuth tokens are rejected globally, including under another provider's name.
  Anthropic's own connection additionally requires its API-key token family.
- Google uses pi-ai's native SDK transport because that adapter rejects custom fetch. Its
  catalog endpoint, explicit key and abort signal remain fixed; it does not inherit the
  other adapters' `redirect: error` fetch wrapper. Non-false `GOOGLE_GENAI_USE_*` environment
  overrides are refused before SDK dispatch, without changing process-wide environment state.
  No live provider requests run in tests.
- `localChat()` reuses K1's Ollama service, acquires the existing process-local governor and
  permits only a loopback runtime. The caller supplies context from runtime/policy; K3
  invents no context cap. Local monetary cost stays unknown.
- `writeArtifact()` scrubs before writing and hashing. The caller must supply an already
  authorized destination. It creates a new file exclusively, with mode 0600; it never
  overwrites an artifact. This is a K4/K5 integration boundary, not an arbitrary-path HTTP API.

## Probes and evidence

OpenRouter's `/api/v1/key` probe reports a **key allowance**, not an account balance.
DeepSeek's `/user/balance` reports its account balance. Each has a minimal recorded
protocol response from the provider's public documentation under `../probes/fixtures/`,
with source and recording time; these contain no live account data. Errors return a stable
summary and preserve prior evidence. Providers without a balance API retain unknown balances
and may accumulate local usage receipts. Admin usage APIs are not implemented by this slice.

Usage receipts are append-only and unique by connection/request. An identical receipt returns
the original; conflicting replays fail. Caller request idempotency and durable model retries
belong to the execution stage; K3 does not retry a model request on its own. Cost is a catalog
estimate, with source/time/confidence, rather than an invoice reconciliation.

Pi-ai is an exact MIT dependency (`@earendil-works/pi-ai` 1.3.0). Two models.dev records are
pinned to commit `f51a64b180710b91a1243868488a55dd359e8b86`, converted to JSON, and attributed
in `THIRD_PARTY_NOTICES.md`, with the original MIT license beside them. Pi-ai and models.dev
facts stay separate, including their differing context/output limits. The snapshot is a
bounded metadata seed, not a mirror of models.dev.

## HTTP and Settings

The local-owner mount is `/api/connections`; account login and remote exposure remain later
stages. Every server route, including the legacy API and SPA, passes an exact Host/port
allowlist before CORS. It accepts loopback authorities, the configured listening authority
and configured Vite authorities, and ignores forwarded headers. Mutations require JSON and same-origin or explicitly configured development origins.
Responses use `Cache-Control: no-store`. Routes list/create connections, change unattended,
unlock/lock, save a key without readback, list model facts and request a balance probe.
The settings UI loads only when Connections is opened; failure does not disable other settings.
A balance without an observation timestamp renders unknown, even when its numeric value exists.
Failures have distinct contract codes for missing connections (404), locked vaults (423),
policy denial (403), unavailable egress protection (503), invalid input (400), provider errors
(502) and internal errors (500). Raw error text never crosses this boundary. The UI offers
Unlock for a locked-vault error, including when the initial list load failed. Routes resolve
the live service for each request after plugin reload.

## Integration and platform limits

K2 has not merged into this lane's main baseline. `egress.ts` copies its documented interface
and provides its required **fail-closed** production stub. The consumer tests use a separate
minimal test scrubber; their trace proves the K3 boundaries, not the combined K2/K3 core.
Until integration, production Connections requests that require scrubbing return an error.
After merging K2: delete the copied interface/stub, import K2's types/provider, load that provider
in the server kernel, switch the consumer tests to it and rerun the trace and full gates.
K2 must declare K3 as an expected secret source before opening writes: an absent, registering,
failed or unloaded `connections.egress-readiness` is unready. Gate event/log/artifact/export
writes on all sources being ready (fail closed or buffer), including during provider reload.
Only then run a restart → tool-print → real K2-event test asserting zero secret matches.
K3's source readiness proves registration completeness, not availability of the temporary stub.
K2 owns event writes/exports; K3 never claims those boundaries from its fixture tests.

The current native keyring is usable on macOS/Windows; real OS prompts/access have not been
exercised in this lane. Its Linux binary statically links libdbus under AFL/GPL terms outside
ADR-0016, so Linux vault activation is refused. An approved backend and separate packaging
license review are required before Linux distribution; the npm SPDX gate alone does not
inspect native crate licenses. No owner keychain or installed model was touched.

## Review 1 key boundary

Migration 2 appends separate node-key-wrapped data keys and per-connection unattended
ciphertexts. Only an unlocked session can create these copies. Revocation removes the node
copy, rotation replaces it, and background injection re-reads consent and uses only the node
key; it never unwraps the session key. Node and session wrapping keys use distinct OS
keychain service namespaces. The database, WAL and SHM files have mode 0600. Existing version-1 secrets remain readable; old
unattended rows need an explicit unlocked re-enable to create a node copy. Rollback must keep
migration 2 and use the fixed consumer (older binaries lack this security boundary).
The vault is private to Connections and is not a kernel service.

Explicit unlock is **not user-presence-gated**: a local same-user HTTP client can request it.
OS keychain access is not a boundary against processes with the same user's privileges.
A later DS2-style signing helper with Touch ID must gate interactive unlock.

The closed provider enum and single T0 connection plugin are bounded K3 implementation
limitations relative to ADR-0017 §2's extensible provider plugins. An additive provider
registration contract and separately loadable adapters remain future integration work;
this slice does not claim that target boundary is implemented. CLI packaging explicitly
declares the native keychain dependency; the browser brand export remains compatible via
the shared node-safe brand module in `@guanxi/contract`.
