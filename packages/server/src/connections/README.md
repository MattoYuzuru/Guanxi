# Model access (K3)

**Status:** implemented; K2 scrubber integrated, locally validated with fake credentials · **Updated:** 2026-10-23

`guanxi.connections` is a T0 kernel plugin requiring `egress.scrubber`, `ollama` and
`governor`. It provides `connections.registry` (`Connections`) and
`connections.egress-readiness` (`ready`, `assertReady()`); its vault is private.
`start()` loads it after the legacy context. D-208 connects provider Chat to this boundary;
local Chat retains the existing Ollama path. Plaintext legacy search settings are unchanged.
K4 consumes the model boundary and K5 executes the registered subscription CLIs.
Search and STT are service connection roles.

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
  require no boot-time keychain read. Registration has a one-second deadline; a stalled or
  unavailable keychain leaves egress pending while the server boots. A later unlock can
  complete registration. Tests use injected throwaway key stores.
- Interactive access requires an unlocked vault. The `unattended` flag is false by default;
  background access also requires both `ownerDevice` and `nodeKeyOptIn` in the immutable
  plugin policy (`StartOptions.connectionsPolicy` for the legacy boot). A node-key unlock
  does not open an interactive session. No HTTP request can enable the node opt-in.
- The known secret registry remains populated when an interactive vault is locked, so old
  tool output is still redacted. Rotation retains old records for that purpose. Plugin
  unload retains them in the long-lived scrubber; registration replaces by reference on reload.
  A fresh activation refuses model/artifact egress if registration is incomplete. Buffers are cleared where possible; JavaScript string erasure is not a
  guarantee.
- `complete()` selects a pi-ai catalog model or an ID discovered for an owner-pinned endpoint,
  scrubs the complete context,
  injects the vault key at dispatch, scrubs the full response and records usage. It exposes
  no login API, arbitrary headers, per-request base URL override or environment credential fallback.
  D-208 explicitly relaxes the original prohibition on base URL overrides: an OpenAI model
  connection may have an immutable `baseUrl`. HTTPS is required except literal loopback HTTP;
  credentials, query strings and fragments are refused. Only that root's `/models` and
  `/chat/completions` paths receive its key; redirects are refused. Changing an imported root
  creates a separate connection, preserving the endpoint of existing Chats.
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

K3 imports K2's `egress/types.ts` and uses the real `egress.scrubber` service loaded by
`bootServerKernel`. The legacy profile declares `expectedSources: ['vault']` before the
session log or Connections loads, so a restart never exposes an empty-ready scrubber.
Connections registers all current and retired vault values at apply, then pushes
`ready('vault')`. Registration-only access leaves interactive injection locked.
`connections.egress-readiness` remains a K3 diagnostic; K2 does not poll it.

While registration is pending, K2 refuses handles, reads, inspector, export and query with
`egress_not_ready`. Its Job mirror records only a Job id in the durable
`session_mirror_backlog`, then reconstructs and scrubs the deferred history after readiness.
No secret-bearing payload is buffered in memory. Until catch-up completes, session reads
answer `session_catching_up`. See [K2 readiness](../egress/README.md#readiness).

`test/connections/k2-integration.test.ts` restarts the node with fresh K2 services and a
throwaway keychain, then writes a failing tool's current/retired vault output before the first
unlock. It asserts zero matches in persisted events/FTS, inspector, exports and both query-tool
audiences, then checks model serialization, response, ledger and the pre-hash artifact.
Rejected/held keychain tests assert pending-source denials and deferred-history recovery.
The consumer suite also uses K2's real provider. These are local fake-credential checks,
not live provider or native keychain validation.

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

## D-208 trusted import and Chat

`StartOptions.providerKeysFile` or `GUANXI_PROVIDER_KEYS_FILE` names an owner-selected dotenv
file. `guanxi connections import --file PATH [--data-dir PATH] [--json]` imports without an
HTTP listener, model request or file-reading HTTP API. The Node dotenv parser treats the file
as data, including literal variable/shell substitutions. Supported names: `OPENAI_API_KEY`,
optional `OPENAI_API_URL` (API root including `/v1` when required), `DEEPSEEK_API_KEY`,
`ANTHROPIC_API_KEY`, `OPENROUTER_API_KEY`, `GOOGLE_API_KEY`. Unknown and empty keys are ignored.
No dotenv values enter `process.env` or act as ambient credential fallbacks.

Import unlocks this process's interactive vault. Standalone CLI disposal locks it again;
boot import leaves it unlocked for Chat. No unattended permission is granted. Migration 3 adds
`dotenv_imports`, a dedicated identity per account/provider/root. Repeated identical input
returns `unchanged`; new values rotate, preserving retired-key scrubbing. Values are registered
before any imported connection metadata is persisted. CLI results expose connection IDs,
provider names and created/rotated/unchanged facts only. Import errors use fixed summaries.
Imports are serialized within one registry; simultaneous standalone processes may require a
repeat after a SQLite/identity conflict. Restart the running node after a standalone import so
its long-lived scrubber registers the new and retired keys before dispatch.

An unlocked, keyed model connection contributes generic groups to `GET /api/threads/models`.
The web picker combines these with the existing local-model projection. It quietly refreshes
provider groups every 15 seconds and on focus, retaining the last successful projection.
Discovery uses the root's `/models` when valid/nonempty, otherwise the pinned pi-ai catalog;
both outcomes cache for 60 seconds and carry source, observation time and confidence. An API
root advertises IDs only: unknown limits remain unasserted, the compatible wire uses backend
defaults, and custom-endpoint monetary cost stays unknown rather than borrowing public prices.
Normal provider usage receipts carry a pi-ai catalog estimate, source/time and confidence.

Provider selections are opaque `k3:<connection UUID>:<encoded model ID>` strings in the existing
Thread model field; old local names remain readable. Provider models are Chat-only. Their
turns use K3 `complete()` under the existing `ChatJobExecutionOwner`, without taking the local
hardware governor. Keys are scrubbed from command content before durable input/title storage
and from complete provider context/output. Stream text withholds possible terminal secret
prefixes across chunks; compatibility transports without streaming return one scrubbed reply.
The existing durable Job/SSE owner retains subscriber-independent execution, locked-vault
idempotent replay, explicit Stop and interrupted recovery without inference continuation.
Provider reasoning text is not projected into legacy Chat; provider compaction is explicitly
refused until a K3-aware compaction implementation exists.

Both local and provider Chat prepend the plain-chat variant of `native-agent/orientation.ts`
through `agent/harness-prompt.ts`. This is the ADR-0021 §8 light-orientation baseline, with only
the product name from the brand module added. It states the local node/OS and the absence of
execution cwd, roots, tools, skills and available path/budget/AGENTS.md details. The English
model-facing prefix is bounded to 300 UTF-8 bytes and independent of UI locale, project metadata
and per-turn state. It stays byte-identical before history on every turn for prefix-cache reuse.
Any future volatile facts belong at the end of the latest user turn, outside this prefix.
Any expansion requires an ADR-0025 bench result; request assertions prove dispatch, not model
quality, cache hits or benchmark non-inferiority. Per-project prompt editing remains future work.

Rollback preserves migration 3, the sidecar and OS wrapping keys. Older binaries cannot consume
new connection fields/provider model selections: do not downgrade a node with provider Chats.
No live provider, owner dotenv or native keychain validation was performed for this lane.
The operator-only smoke is `scripts/chat-provider-smoke.ts`; see the lane handoff for its command.
