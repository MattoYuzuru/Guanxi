# K3-chat review fixes — handoff

Status: locally validated; all requested gates passed; independent review closed.
Branch: `claude/chat-provider-models`. Review-fix base: `1ee33db3`.
Final tested code candidate: `8a14c9d64145724a1f36626eeb96ca80d308c656`; this final handoff is a docs-only follow-up.
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

**New:** 23 server/CLI cases, 4 web component cases and 1 mocked browser case.
**Affected envelope:** 139 server/CLI (23 new / 116 existing), 54 web components
(4 new / 50 existing). The 139 include 9 existing operational-relay cases after the gate repair
below. All passed, zero skips. The separate browser envelope passed 225 cases: 1 new / 224 existing. Focused runs already cover generated credentials, temporary SQLite
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

| Gate | Final result |
| --- | --- |
| `npm run typecheck` | pass, all workspaces; final HTTP assertion delta also passed `npx tsc --noEmit -p packages/server` |
| `npm run lint:md` | pass, Markdown and links, repeated after final handoff |
| `npm run check:licenses` | pass, 675 packages, zero not allowed |
| `npm run lint:js` | pass, zero errors, four pre-existing noInlineConfig warnings |
| Affected server/CLI tests | 139/139 passed, no skips |
| Affected web component tests | 54/54 passed, no skips |
| `npm run ui:check` | pass directly after token correction and inside final full gate |
| Locked `npm run test` | pass; core 2,738 passed / 2 expected Linux-only skips; web components 659 passed; all other phases passed |
| Locked `npm run test:web:browser` | 225/225 mocked Chromium cases passed, no skips |

Full gate includes UI fast gates/self-tests, codemods, server/CLI, kernel, web components, UI and
bench. The core envelope contains 2,740 cases: 23 new / 2,717 existing (including the two
platform skips). Those skips are Linux worker nice/IO priority and Linux proxy long-TMPDIR
scratch; no K3-chat test is skipped. The full web component envelope is 4 new / 655 existing.

Final locked receipts (each `ok: true`, exit 0, no timeout, clean candidate before/after and
`source_changed: false`):

```text
/Users/yuzuru/.local/state/agent-dev/check-xjqctzxc/result.json
/Users/yuzuru/.local/state/agent-dev/check-e09y5hkh/result.json
```

The browser gate took 4.3 minutes. It uses mocked APIs without Ollama, GPU or paid provider
access; it is not production validation. No build gate was requested or claimed in this round.

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
Inspector follow-up `c636e2e4` removes a fabricated percentage and renders provider source/time
or Unknown in both facts and timeline; `adf2566c` asserts the exact unknown observation note.
Reviewer closed this and the contract-validated browser fixture through `016f4770`.
The G5 fix below was also independently checked: existing semantic token, no suppression growth.
Reviewer confirmed `ac42360b` keeps every relay assertion and timeout unchanged, and confirmed
`8a14c9d6` exercises HTTP refusal before registry creation. No outstanding review findings.
Heavy gates were executed by the author after review; no source changed while they ran.
Heavy gates and live behavior were outside that review.

## Gate repairs and failed attempts

- First locked full attempt at `016f4770`: `check-8nw0i0tk`, exit 1, no timeout or source
  change. G5 rejected the new ContextPanel `text-xs` use before core tests started.
  Separate fix `2feba7d1` uses the existing `text-12` token. Direct `ui:check` then passed,
  followed by repeated light gates and the 130/54 affected tests.
- Second locked attempt at `2feba7d1`: `check-n3r_f3ab`, exit 1, no timeout or source change.
  UI gates passed; core ran 2,740 cases: 2,737 passed, one failed, two platform skips.
  MS1 passed. The only failure was operational-relay's allocation-cancel fixture: expected
  `cleanup_unconfirmed`, observed `relay_stopped`. Later phases did not run.
- The fixture counted entry into the allocator before filesystem ownership existed. On a
  slow filesystem, cancellation could hit the pre-allocation abort check; `relay_stopped`
  correctly described that path and the injected removal failure never ran. Independent
  review confirmed this exact ordering. A temporary 50 ms pre-allocation scheduling probe
  reproduced the same failure, then passed with the fix; the probe was removed.
  Separate test fix `ac42360b` waits for `runtime/scratch`, created after the ownership marker,
  in both branches. Every outcome/count assertion and timeout stays unchanged; no relay
  production code changes. Its complete 9-case file passes, zero skips. This is an
  investigated synchronization defect, not a known-flake exemption.

Receipts live under `/Users/yuzuru/.local/state/agent-dev/<check>/result.json`; each names its
sibling redacted `output.log`. The pre-existing `.claude/skills/guanxi-ui` symlink makes source
attestation/reusable receipts unavailable; execution results still record clean HEAD before
and after plus `source_changed: false`. No symlink or unrelated owner file was changed.

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
keys, runtime lifecycle docs, OPEN_QUESTIONS, and the existing relay allocation-cancel fixture
synchronization required to repair the full gate. No PHASE_STATUS or NEXT_AGENT_PROMPT edit in a lane.
No copied third-party code. Exact MIT `undici` 8.9.0 is now a direct server dependency for pinned
socket lookup; lockfile records the workspace declaration.

UI: existing ChatPage, ContextPanel/ContextChip and InspectorPage only; no new catalog component,
CSS, review-status change or suppression allowance. Catalog search found ProvenanceLabel draft;
existing semantic text is retained. Browser gate is mocked Chromium, not a live runtime check.

Next: the integrator reviews and incorporates this lane, then runs its own integration gates.
No merge or push was performed here. Later K3-aware compaction/reasoning and prompt
benchmarking remain separate work; Q-K3-chat stays open until its ADR-0025/B1 result.
