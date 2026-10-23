# K3-chat implementation plan

Status: autonomous under D-208 and the lane owner's instructions. Base: `631cd5c8`.

## Outcome and scope

- Import owner-designated dotenv data through boot and a local CLI into the K3 vault.
- Persist an immutable OpenAI-compatible endpoint per connection; validate HTTPS or loopback,
  reject credentials/query/fragment and redirects. No request-level endpoint or environment keys.
- Expose generic chat model groups combining Ollama and usable K3 connections, including
  model-list provenance; retain the existing picker styling.
- Route provider Chat through K3 completion and the existing durable Job/SSE projection.
- Prepend a short English/Russian harness identity prompt to local and provider Chat.

## Defaults

- Import only explicitly supported model-provider key names, with no shell interpolation.
  Imported connections are named by provider and dedicated import identity. No unattended opt-in.
- A trusted import may unlock the vault for this process; the standalone importer closes it.
  Compare decrypted current keys without persisting plaintext or a public key fingerprint.
- OPENAI_API_URL is fixed on an imported connection. Endpoint changes create a new identity;
  they never redirect an existing conversation's key silently.
- Custom OpenAI endpoints use the chat-completions protocol. Discover `/models` with an explicit
  vault key and bounded timeout; fall back to the pi-ai catalog with explicit provenance.
- Provider streaming may buffer text at the K3 scrubber boundary to avoid partial-secret leaks.
  Durable execution remains independent from subscribers; restart interrupts rather than retries.
- Prompt locale follows node settings; node identity defaults to the local-node label, project identity
  uses only a display name. No hostname, filesystem root or credentials enter the prompt.
- Per-project prompt editing is deferred. B1/ADR-0025 benchmark evidence is unavailable for this
  lane; fake-transport assertions establish dispatch, not model quality or non-inferiority.

## Boundaries and migration

Contract, K3 registry/vault/transport, trusted CLI and boot, durable chat owner, chat picker,
Settings host display and related route/component tests are in scope. Minimal shared edits to
legacy thread/project creation and model validation are recorded in the handoff.
Existing connection JSON gains optional fields; any new K3 tables use append-only migration 3.
Existing local model strings and old connection records remain readable. Rollback retains the
sidecar and vault keys; provider threads require the new consumer and must not dispatch to Ollama.
No real dotenv, live provider, SSH, owner data, push or status-file edits.
No third-party code is copied; reuse pinned pi-ai and existing UI components.

## Verification

New tests: data-only dotenv parsing; idempotence/rotation; canary scans of outputs/errors/storage;
endpoint validation and pinned transport; discovered/fallback catalog provenance; grouped picker;
fake pi-ai durable chat including cancellation/replay, scrubbed request/result, harness prompt;
local prompt and contract/route compatibility.

Gates: Node 26 and lane ports/data, `npm ci`, workspace resolution, `typecheck`, `lint:md`,
`check:licenses`, `lint:js`, `ui:check`. Heavy `test`, `test:web:browser`, `build` only through
`/Users/yuzuru/.local/bin/agent-dev run --cwd /Users/yuzuru/Projects/Guanxi-lanes/chatmodels
--node 26 --resource heavy --lock-timeout 3600 -- npm run <gate>`.
Separate read-only reviewer after implementation; findings fixed in separate commits.
Separate plan, implementation, tests and docs commits. Handoff records new/envelope evidence,
receipts, review, limitations and the exact operator-only live smoke command.
