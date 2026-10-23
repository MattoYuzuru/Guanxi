# K3-chat handoff — D-208

Status: implemented and locally validated with fake providers; all required local gates passed.
Branch: `claude/chat-provider-models`. Base/main: `631cd5c8`.
Tested code candidate: `23adfcbe`. No push, merge, live provider, real dotenv, SSH or owner-data access.

## Delivered

- Boot option `providerKeysFile` / `GUANXI_PROVIDER_KEYS_FILE`, plus local
  `guanxi connections import --file PATH [--data-dir PATH] [--json]`.
  Data-only Node dotenv parsing; dedicated per-provider/root identities; same-value no-op,
  rotation with retired-key scrubbing, no unattended grant, fixed safe errors.
- OpenAI-compatible immutable `baseUrl`, HTTPS except loopback, no URL credentials/query/fragment,
  no redirects or request-level override. Secret-bearing roots fail before metadata/mapping writes.
  `/models` discovery and fallback carry provenance/time; both cache for 60 seconds.
- Provider groups at `GET /api/threads/models`, combined with local choices by the web picker.
  Connection UUIDs keep equal-label groups distinct. Quiet refresh retains successful data on
  transient failure and clears a removed provider selection; no visual restyling or CSS edits.
- Provider Chat runs K3 `complete()` inside the existing durable Job/SSE owner. It skips the
  local hardware permit and prewarm, supports pi-ai text streaming with cross-chunk scrubbing,
  records usage/catalog estimate, and preserves disconnect, Stop, locked replay and interrupted
  recovery semantics. Custom endpoint prices/limits stay unknown; its wire uses backend defaults.
- Short English/Russian harness prompt follows node locale: central brand, local-node label,
  project display name only, harness tools/permissions. Per-project editing is deferred.
- Settings displays only a compatible connection's API host.

See [Connections](../../../packages/server/src/connections/README.md#d-208-trusted-import-and-chat)
and the [plan](K3-chat.plan.md) for defaults and boundaries.

## Migration and recovery

Append-only K3 migration 3 adds `dotenv_imports`. Legacy schema and user data paths are unchanged.
Keep the sidecar and OS wrapping keys. Do not downgrade to a binary that cannot parse provider
connections/selections. Root changes create a new connection rather than redirecting existing Chats.
Boot import leaves the interactive vault unlocked; standalone CLI closes it on disposal.
Restart a running node after a standalone import to register newly stored current/retired keys.
Concurrent imports serialize inside one registry; separate CLI processes can require retry after
an identity/SQLite conflict. No plaintext digest or key fingerprint is exposed.

## Evidence — new

24 new tests: 16 server, 2 CLI, 5 picker and 1 Settings-host assertion.

- Dotenv literal substitutions/quotes/comments, ignored unknown keys, idempotence, rotation,
  same-process concurrency, root identity, fixed errors and generated canary scans across
  import results, console methods, connection snapshots, SQLite/WAL, history, durable input/events.
- URL validation, discovery deduplication/source/time/cache, catalog fallback, locked/keyless/service
  exclusion, pinned compatible dispatch, escaped target refusal and unknown custom prices.
- Split/overlapping key redaction, fake provider durable SSE after disconnect, one assistant/receipt,
  locked-vault replay and conflicting replay, explicit Stop, fresh-owner interrupted recovery.
- Localized local prompt and dispatched provider harness identity/scrubbed context; real pi-ai wire
  over fake fetch streams without borrowing an unrelated model's output ceiling.
- Provider-only picker, local fallback, no provider prewarm, Agent switch payload, quiet refresh,
  same-name connection group counts/ancestry, Settings host without API-root path.

Targeted commands passed: `node --test packages/server/test/connections/chat-provider.test.ts
packages/cli/test/connections-import.test.ts` (18/18); web Vitest picker + Connections files
(27/27: 6 new, 21 existing assertions); existing K3 model-access regressions (50/50).
Combined targeted evidence: 24 new / 71 existing regression tests. These use generated fake keys,
throwaway stores/keychains and fake transports; no live authentication or provider quality is implied.

## Evidence — regression envelope and gates

All commands used Node 26, web/API ports 5236/4436 and the isolated `.lane-data` directory.

| Gate | Result | Evidence |
| --- | --- | --- |
| `npm ci` / workspace resolution | pass | own checkout; `@guanxi/contract` resolves here |
| `npm run typecheck` | pass | all workspaces; operator script also typechecked separately |
| `npm run lint:md` | pass | docs/link check, including final handoff |
| `npm run lint:js` | pass | 0 errors; 4 existing noInlineConfig warnings |
| `npm run check:licenses` | pass | 675 packages, 0 disallowed |
| `npm run test` | pass | `check-b2avddf_` |
| `npm run test:web:browser` | pass | 224 mocked Chromium cases; `check-fkt8wt5s` |
| `npm run build` | pass | web/server/CLI; `check-7jxv_wrt` |

Heavy commands used exactly the lane's `agent-dev --node 26 --resource heavy --lock-timeout 3600`
wrapper, one command per call, stopping on failure. Final receipts report `ok: true`, exit 0,
HEAD `23adfcbe64c98c71f7dff86a243c8ace46117e21`, and `source_changed: false`:

```text
/Users/yuzuru/.local/state/agent-dev/check-b2avddf_/result.json
/Users/yuzuru/.local/state/agent-dev/check-fkt8wt5s/result.json
/Users/yuzuru/.local/state/agent-dev/check-7jxv_wrt/result.json
```

Each receipt names its sibling `output.log`. The server/CLI envelope has two expected Linux-only
skips on macOS (worker scheduling/IO priority and Linux proxy scratch); the other suites report
no skips. Web component envelope: 655 passed. Browser gate: 224 passed, no new browser tests.

The full `npm test` envelope includes UI fast/self-test gates, codemods, server/CLI, kernel,
web components, UI and bench. The separate browser gate is mocked Chromium, without live
Ollama/GPU/providers. Build checks web/server/CLI bundling. Gate receipts are execution evidence;
agent-dev reports the pre-existing `.claude/skills/guanxi-ui` symlink as unsupported, so source
attestation/reusable receipts remain unavailable. Use the recorded candidate and logs.

Earlier attempts: initial full run stopped at G5 because a new `text-2xs` use exceeded the frozen
allowance; fixed to `text-12`. Its receipt also records source changes during that attempt.
The full run at `7fb16210` then found one stale migration-test expectation (`[1, 2]` versus
`[1, 2, 3]`), fixed in `23adfcbe` while retaining all data-preservation assertions.
Another earlier run was interrupted by the author to apply independent-review fixes; it is not
credited as passing evidence. Final checks ran with a quiet source tree.

## Independent verification

Separate read-only reviewer inspected the baseline diff and follow-ups; no heavy checks or live
access. Findings: raw durable command/title, locked-vault replay admission, hidden provider
selection on Agent switch, ineffective restart assertion, uncached failed discovery, and a
secret-bearing root in import metadata. Fixed in `cb5abc1b`, `d7244005`, `b6a15eb1`; direct
assertions added. Reviewer confirmed closure at `b6a15eb1`, then independently accepted
`4fc72aa5` and `388f210c` for removed/equal-name provider choices, and `23adfcbe` for the
stronger version-1 upgrade fixture, with no new findings.
Model-family-independent review was unavailable; the integrator still owns that merge gate.

## Operator-only live smoke

Run after integration/tests with the owner-designated file. These commands were **not run**
in this lane. They access the native keychain and make paid provider requests. They use a
separate ignored data directory, print only result facts/references, and close their own node.
A busy port fails; never stop somebody else's process.

```bash
export PATH=/opt/homebrew/opt/node@26/bin:$PATH
export GUANXI_WEB_PORT=5236 GUANXI_API_PORT=4436
export GUANXI_DATA_DIR="$PWD/.lane-data/live-smoke"
node packages/server/scripts/chat-provider-smoke.ts "$PWD/.env" deepseek
node packages/server/scripts/chat-provider-smoke.ts "$PWD/.env" openai
```

Substitute only the file path if the owner uses a different filename. The script imports,
reads provider picker data, creates a Chat, sends one harness-identity turn through POST/SSE,
requires completed output and a usage receipt, then closes the node. It does not print response
text or claim model-reported identity is independent attestation.

## Residual risks and next slice

- Live provider credentials, proxy-specific models/protocols and native keychain prompts remain
  operator checks. Linux keyring distribution limits from K3 remain unchanged.
- Provider reasoning is not projected in legacy Chat; provider compaction explicitly refuses
  dispatch. Next slice: K3-aware compaction, optional reasoning projection and per-project prompts.
- Local-node identity defaults to the local label; federated identity customization is future work.
  Legacy Chat timing fields retain their older projection, not provider latency measurements.
- ADR-0025 benchmark/non-inferiority evidence is unavailable; D-208 authorizes the fixed prompt
  default. No quality, production validation, full UI visual approval or invoice reconciliation.
- UI redesign integration must preserve the generic groups/selection contract. Existing legacy
  Select receives data grouping only; no catalog component/review status or CSS was changed.
  Catalog search found `select` still draft, so no new product use was introduced.

## Shared edits and commits

Shared seams: contract connections; CLI bin/export; server index/context, legacy turn loop,
thread/project routes/admission, Job lookup, vault comparison and runtime lifecycle docs;
web legacy Select, ChatPage/resource-conflict hook, API client and Connections host/locale strings.
No PHASE_STATUS/NEXT_AGENT_PROMPT, unrelated lane, generated asset, license or dependency edits.

Commits before handoff: `6f89f3d0` plan; `947baf32` implementation; `d269779b` provider admission;
`2fc52628` tests; `cb5abc1b` input/fallback fixes; `d7244005` review fixes, wire assertions/docs/smoke;
`b6a15eb1` secret-bearing root fix; `4fc72aa5` quiet refresh; `388f210c` group identity;
`7fb16210` Settings-host test; `23adfcbe` migration regression fixture. Final docs-only commit contains this evidence file.
