# Model access (K3)

**Status:** implemented; K2 scrubber integrated, locally validated with fake credentials · **Updated:** 2026-10-24

`guanxi.connections` is a T0 kernel plugin requiring `egress.scrubber`, `ollama` and
`governor`. It provides `connections.registry` (`Connections`) and
`connections.egress-readiness` (`ready`, `assertReady()`); its vault is private.
`start()` loads it after the legacy context. D-208 connects provider Chat to this boundary;
local Chat retains the existing Ollama path. Plaintext legacy search settings are unchanged.
K4 consumes the model boundary and K5 executes the registered subscription CLIs.
Search and STT are service connection roles.

## Catalog and local runtime

The contract exports a frozen `providerCatalog` (one entry per provider) with its
category, connection route, key hint, documentation link, API-root policy and model
source. `providerCategoryOrder` is the display order. Product labels are literal
names; UI chrome around them stays in locale keys.

At every plugin apply the registry ensures one `local_runtime`/`ollama` connection
named `Ollama` for account `local`. The check and insert share one immediate
transaction, so a restart or a concurrent apply cannot add a second one. It has no
secret, never opens the vault and never contacts Ollama. An existing local Ollama
connection is returned unchanged. `GET /api/connections/:id/models` resolves a
local runtime through the existing Ollama adapter (`/api/tags`), bounded to five
seconds and 1,024 IDs; an unreachable runtime is the typed `provider_failed` error,
not an internal error.

## Boundaries

- The contract in `@guanxi/contract` defines kinds, supported routes, facts, balances,
  references, usage receipts and settings responses. Clients only receive references.
- The registry, ledger and vault use `connections.sqlite` next to the node database. K3's
  migration version table is independent of legacy `user_version`. Version 1 creates new
  tables; version 4 adds only `removed_connections` and leaves the migration history append-only.
  Never rewrite a migration after distribution. Removing the plugin leaves this database
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
  connection may have an immutable `baseUrl`, supplied only by trusted file/CLI import;
  HTTP creation rejects endpoint and network-policy fields. Custom dispatch resolves DNS once,
  validates every answer and pins the socket IP while preserving Host/TLS identity.
  Link-local IPv4/IPv6 is always refused, including mapped IPv4. Private/loopback addresses
  require `GUANXI_PROVIDER_ALLOW_PRIVATE=1` in the imported file, recorded on the connection
  at import. Trusted reimport explicitly updates or revokes this stored policy for an existing
  endpoint; omitting the opt-in resets it to denied. HTTP cannot grant or revoke that consent.
  HTTP is limited to loopback or an opted-in private LAN; public endpoints require HTTPS;
  credentials, query strings and fragments are refused. Only that root's `/models` and
  `/chat/completions` paths receive its key; redirects are refused. An imported root with a different secret
  creates a separate connection. Reimporting the same secret with another root
  reuses its connection and updates that root, preserving the endpoint identity of
  existing Chats.
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
unlock/lock, save a key without readback, list model facts (pi-ai catalog, discovered endpoint IDs or installed models for a local Ollama runtime), request a balance probe and remove a connection.
`DELETE /api/connections/:id` soft-removes the row through the append-only migration 4 table
`removed_connections`: it disappears from the snapshot, every model/connection picker and the
cost projection, while its cost ledger rows stay for append-only accounting. The dotenv import
mapping is dropped, so a later trusted import creates a new connection; its vault records and
retired refs stay registered for the egress scrubber, exactly as rotation retains old records.
The node-key copy is removed. Removal refuses with `connection_in_use` (409) while this registry
has an active `complete()`, `localChat()` or `dispatchAgent()` call. It does not inspect durable
relay/lead/session state outside this process; that state has other owners.
The settings UI links to the connections centre at `/connections`; failure here does not disable other settings.
A balance without an observation timestamp renders unknown, even when its numeric value exists.
Failures have distinct contract codes for missing connections (404), in-use connections (409),
locked vaults (423), policy denial (403), unavailable egress protection (503), invalid input (400),
provider errors (502) and internal errors (500). Raw error text never crosses this boundary. The UI offers
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
`ANTHROPIC_API_KEY`, `OPENROUTER_API_KEY`, `GOOGLE_API_KEY`. Unknown and empty keys are ignored, but a file without a supported nonempty key fails.
`OPENAI_COMPAT_API_KEY` plus required `OPENAI_COMPAT_API_URL` imports an OpenAI-compatible
connection alongside official OpenAI. Legacy `OPENAI_API_URL` still redirects only the
`OPENAI_API_KEY` connection. Each root is an API root, including `/v1` where required.
New connections take their name from `providerCatalog` (`OpenAI`, `DeepSeek`,
`Anthropic`, `Claude Code`, ...); an OpenAI import with a root is
`OpenAI-compatible (<host>)`. The origin is recorded as the `origin` fact
(`provider_key_import`), never appended to the name. A later import replaces an old
`<provider> (dotenv)` name.
A leading BOM and CRLF are accepted. A raw line scan refuses duplicate names, unterminated
single-line quotes and unquoted `#` truncation before parsing; quote values containing `#`.
Multiline key values are unsupported. Validation failures identify only supported key names
and fixed codes, never values. A bad URL/key does not prevent other valid providers' import;
CLI JSON includes `imported` and optional `errors`, and partial failure exits nonzero.
No dotenv values enter `process.env` or act as ambient credential fallbacks.

**D-212 token mode.** Asked for by the MS1 lead (`home.lead.auth: "oauth_token"`), the import also reads `CLAUDE_CODE_OAUTH_TOKEN`, or an
`sk-ant-oat` value under `ANTHROPIC_API_KEY` when the first name is absent, and stores it on a `claude-code` *agent* connection
(`Claude Code`). `dispatchAgent` hands it to K5 for the official CLI's environment and to nothing else; `complete()`, chat and
`saveSecret` refuse it, and `assertApiKey` still refuses the `sk-ant-oat` family as an API key. Without that option the token names are ignored.

Import unlocks this process's interactive vault. Standalone CLI disposal locks it again;
successful boot import leaves it unlocked for Chat. Boot import failure (including partial
failure) logs only `provider_key_import_failed`, locks provider access and continues booting;
valid keys from a partial import remain stored and can be explicitly unlocked later. No unattended permission is granted. Migration 3 adds
`dotenv_imports`, a dedicated identity per account/provider/root. Repeated identical input
returns `unchanged`; a new value rotates the mapped connection, preserving retired-key
scrubbing. When the same secret arrives under another root, the registry reuses the imported
connection that already holds it and updates its root (and network consent) instead of adding
a second row; a different secret keeps a separate connection. Values are registered before
any imported connection metadata is persisted. CLI results expose connection IDs, provider
names and created/rotated/unchanged facts only. Import errors use fixed summaries.
Imports are serialized within one registry; simultaneous standalone processes may require a
repeat after a SQLite/identity conflict. Restart the running node after a standalone import so
its long-lived scrubber registers the new and retired keys before provider dispatch. Local
legacy Chat remains available with incomplete vault registration or a missing Connections
plugin: it scrubs with the currently registered set when possible. Provider sends still
require complete vault scrubbing readiness. This local availability does not relax K2
inspector/export readiness or K3's other egress boundaries.

An unlocked, keyed model connection contributes generic groups to `GET /api/threads/models`.
The web picker combines these with the existing local-model projection. It quietly refreshes
provider groups every 15 seconds and on focus, retaining the last successful projection.
Custom discovery uses only that root's `/models`, bounded to 1 MiB, 1,024 entries and
256 characters per model ID. The contract enforces the list/ID bounds too. Public source
labels and connection displays expose only the authority, never the API root path.
Discovery success and failure are cached for 60 seconds. A failed refresh retains the last
successful list with its original observation time, state `stale` and confidence `low`;
without a prior success, the list is empty with state/confidence `unknown`. An ordinary
connection without a custom root uses its pinned pi-ai catalog. Custom endpoints never
fall back to OpenAI membership or inherit matching `gpt-*` compatibility settings;
completion uses a neutral chat-completions template and does not repeat discovery admission.
The HTTP request's abort signal reaches discovery. An API
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
refused until a K3-aware compaction implementation exists, and its UI action is absent.
Context projections use catalog window evidence with source/time/confidence for ordinary
providers, or an explicit unknown window for custom endpoints; local `numCtx` is never the
provider window. Unknown allocation/percentage are nullable, including in durable events.
Startup reconciles interrupted jobs early but schedules queued Chat only after Connections
activation/import; a locked provider job retains the `vault_locked` failure code.
API errors preserve connection categories (404 missing, 423 locked, 503 scrubbing unavailable)
and the client renders curated locale messages.

Both local and provider Chat prepend the plain-chat variant of `native-agent/orientation.ts`
through `agent/harness-prompt.ts`. This is the ADR-0021 §8 light-orientation baseline, with
the product name from the brand module and a fixed English language instruction. It states the local node/OS and the absence of
execution cwd, roots, tools, skills and available path/budget/AGENTS.md details. The English
orientation itself retains its 300-byte bound; the complete model-facing prefix is bounded to 350 UTF-8 bytes and independent of UI locale, project metadata
and per-turn state. It stays byte-identical before history on every turn for prefix-cache reuse.
When switching a locally compacted Chat to a provider, checkpoint summaries stay in user history
after the orientation; they are never folded into the provider system prompt.
Any future volatile facts belong at the end of the latest user turn, outside this prefix.
The orientation is first, followed by the fixed line "Reply in the language the user writes in."
This owner-requested Chat default awaits an ADR-0025/B1 bench result (Q-K3-chat in
[open questions](../../../../docs/plans/OPEN_QUESTIONS.md)). Any further expansion requires that result; request assertions prove dispatch, not model
quality, cache hits or benchmark non-inferiority. Per-project prompt editing remains future work.

Rollback preserves migration 3, the sidecar and OS wrapping keys. Older binaries cannot consume
new connection fields/provider model selections: do not downgrade a node with provider Chats.
No live provider, owner dotenv or native keychain validation was performed for this lane.
The operator-only smoke is `scripts/chat-provider-smoke.ts`; see the lane handoff for its command.
