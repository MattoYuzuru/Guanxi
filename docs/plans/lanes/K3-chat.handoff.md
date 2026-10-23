# K3-chat review fixes — handoff

Status: implemented with fake-provider regressions; final gates in progress.
Branch: `claude/chat-provider-models`. Review-fix base: `1ee33db3`.
No push, merge, real dotenv, owner data, live provider/model calls or remote-host access.

## Scope and commits

| Finding | Fix commit | Observable change |
| --- | --- | --- |
| P1-1 local isolation | `13d0a47d` | Local sends survive unregistered vault rows and missing K3; registered values are scrubbed best-effort. Provider sends still require readiness. |
| P2-1 endpoint authority | `8c012dac` | HTTP creation refuses roots/consent. Trusted import records private-network opt-in; DNS answers are checked and the socket IP pinned. Link-local always denied; private/loopback need consent; public HTTP denied. |
| P2-2 discovery | `f933f556` | Custom discovery returns endpoint-only current/stale/unknown evidence. Completion avoids repeat discovery and uses a neutral compatible template. |
| P2-3 prompt | `6957cb3f` | Shared orientation first, fixed language instruction second, 350-byte combined budget; dead prompt removed; Q-K3-chat awaits ADR-0025/B1. |
| P2-4 parser/admission/UI | `2a0fe2b4` | BOM/CRLF and strict raw syntax scan; no supported key fails. Held-permit and component/browser provider bypass coverage. `c1b25442` fixes the scan's TypeScript capture type. |
| P3 recovery | `5e25c13b` | Reconciliation runs early; queued execution waits until Connections activation/import. |
| P3 provider context | `8bc21a98` | Catalog window with provenance or nullable unknown, never local numCtx; provider compaction action absent. |
| P3 metadata | `8e469026` | Public connection roots contain only origin; discovery source contains only host/port. |
| P3 discovery bounds | `fa93b0b1` | 1 MiB response cap, 1,024 models, 256-character IDs; contract maxima match. |
| P3 route contract | `eb8bc64d` | `ROUTES.threadModels()` is shared by the web client. |
| P3 errors | `58e6c99f` | Connection codes/statuses survive admission and turn projection; curated locale messages. |
| P3 cancellation | `ac5994d4` | Send request signal reaches custom discovery. |
| P3 partial import | `996607c4` | Bad provider URL/key reports only key name/code; other valid keys import. CLI partial result is nonzero. |
| P3 separate compatible key | `74e93541` | `OPENAI_COMPAT_API_KEY` + required `OPENAI_COMPAT_API_URL`, alongside official OpenAI; legacy `OPENAI_API_URL` retained. |
| P3 boot failure | `9e582426` | Fixed `provider_key_import_failed` warning, locked provider access, node keeps booting. |
| Independent finding: consent replay | `d1cfe5e0` | Trusted reimport updates/revokes persisted network consent. |
| Independent finding: SDK error loss | `f8853379` | Real pi-ai retains `policy_denied` instead of replacing it with `provider_failed`. |

The two independent findings each have a reproduced failing regression followed by a passing
fix in their own commit. Other behavior fixes likewise used failing focused regressions;
existing correct provider governor/UI bypass behavior received stronger tests without a
production workaround. No assertion was weakened to turn a failure green.

## New / regression envelope

Pending final result counts. Focused runs already cover generated credentials, temporary SQLite
and fake keychains/transports only. The DNS pin test talks to its own ephemeral loopback HTTP
fixture, preserving Host without another DNS lookup. It does not call a provider.

The added assertions cover local isolation; unsafe roots and private/link-local/mapped addresses;
LAN HTTP consent and mixed DNS answers; persisted consent grant/revoke; custom stale/unknown
and neutral compatibility; byte-stable language prompt; held governor permit; BOM/CRLF/raw
syntax; deferred recovery; provider context in REST/SSE/UI; host-only metadata; discovery
bounds; shared route; actionable errors; cancellation; partial/two-endpoint import; safe boot;
real pi-ai endpoint policy-code preservation. Web tests cover enabled provider composer with
Ollama down and no local resource decision; a mocked browser case checks the same flow.

## Gates

Node 26.9.0 on the current Mac, lane ports 5236/4436, isolated `.lane-data`.
Final results and locked receipts will be recorded after execution.

Required order: `typecheck`, `lint:md`, `check:licenses`, `lint:js`, affected tests, then:

```bash
/Users/yuzuru/.local/bin/agent-dev run --cwd /Users/yuzuru/Projects/Guanxi-lanes/chatmodels --node 26 --resource heavy --lock-timeout 3600 -- npm run test
/Users/yuzuru/.local/bin/agent-dev run --cwd /Users/yuzuru/Projects/Guanxi-lanes/chatmodels --node 26 --resource heavy --lock-timeout 3600 -- npm run test:web:browser
```

The earlier baseline handoff recorded one full-envelope external-agent reconciliation failure
at `25721046` and isolated success. That is historical, not a known-flake allowance or current
gate evidence. Any recurrence must be investigated. The original delivery's prior green heavy
receipts are not credited to this correction.

## Independent verification

A separate read-only reviewer inspected `1ee33db3..f8853379` under WORKFLOW §4. It found the
consent replay and pi-ai error-code defects above, confirmed both separate fixes and ran
38/38 endpoint/chat cases on Node 26.9.0, zero skips. No remaining confirmed defect in that
scope. It requested explicit LAN HTTP and mixed DNS-answer assertions; these are added.
Final inspector unknown-state follow-up and final gate evidence are recorded below when ready.
Heavy gates and live behavior were outside that review.

## Migration, operator behavior and limits

No new SQLite migration. Optional `allowPrivate` is stored in connection JSON; old rows default
to private-network denial. Trusted reimport updates or revokes consent; HTTP cannot set it.
Unknown provider allocation/percentage are nullable in contract, REST and durable events.
Keep the sidecar, historical secrets and OS wrapping keys. Downgrading a provider-Chat node to
an older consumer does not preserve these new projections/policies.

Boot full/partial import failure logs a fixed code, locks provider access and keeps booting.
Other valid keys in a partial file remain stored; explicit unlock can make them available.
Standalone import still requires restarting the running node to register newly stored secrets
before provider egress; local Chat stays available. K2 inspector/export readiness remains closed
until all required vault values are registered. See
[Connections](../../../packages/server/src/connections/README.md#d-208-trusted-import-and-chat).

No live credentials, OS-keychain prompts, Linux keyring activation, paid-provider behavior,
model quality or benchmark non-inferiority was tested. Q-K3-chat explicitly awaits ADR-0025/B1.
Provider reasoning projection and actual provider compaction remain future slices.

## Shared edits and next slice

Shared seams: contract connections/errors/context/ROUTES, CLI import/bin, legacy context/start,
thread/project context projections, durable Chat owner/turn loop, inspector/context UI and locale
keys, runtime lifecycle docs, OPEN_QUESTIONS. No PHASE_STATUS or NEXT_AGENT_PROMPT edit in a lane.
No copied third-party code. Exact MIT `undici` 8.9.0 is now a direct server dependency for pinned
socket lookup; lockfile records the workspace declaration.

UI: existing ChatPage, ContextPanel/ContextChip and InspectorPage only; no new catalog component,
CSS, review-status change or suppression allowance. Catalog search found ProvenanceLabel draft;
existing semantic text is retained. Browser gate is mocked Chromium, not a live runtime check.

Next: finish the current review-fix gates and evidence, then hand off to the integrator. Do not
merge or push. Later K3-aware compaction/reasoning and prompt benchmarking remain separate work.
