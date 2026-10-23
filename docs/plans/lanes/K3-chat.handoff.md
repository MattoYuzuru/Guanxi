# K3-chat handoff — D-208

Status: correction implemented and focused checks passed with fake providers; the follow-up full
suite failed one external-agent reconciliation test. Integration remains gated on a green full run.
Branch: `claude/chat-provider-models`. Base/main: `631cd5c8`.
Follow-up tested code candidate: `25721046` (original passing candidate: `23adfcbe`).
No push, merge, live provider, real dotenv, SSH or owner-data access.

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
- Chat reuses the English ADR-0021 light orientation with central brand identity and truthful
  no-tools facts, independent of locale/project metadata. See the integrator correction below.
- Settings displays only a compatible connection's API host.

See [Connections](../../../packages/server/src/connections/README.md#d-208-trusted-import-and-chat)
and the [plan](K3-chat.plan.md) for defaults and boundaries.

## Integrator correction — ADR-0021 baseline

The earlier brief's localized identity prose is superseded. This is the existing ADR-0021 §8
light-orientation baseline from `native-agent/orientation.ts`, **not a new prompt**. Only
`PRODUCT_NAME` from the brand module is added. Plain Chat states local node/OS, no execution
cwd/roots/tools/skills, and unavailable path/budget/AGENTS.md details. The native-agent variant
retains its existing bytes. Any expansion requires an ADR-0025 bench result; no quality,
non-inferiority or actual cache-hit result is claimed.

`agent/harness-prompt.ts` delegates to that single source. The 300 UTF-8-byte guard remains,
and the English model-facing prefix has no locale, project names, paths, secrets, timestamps,
quotas or counters. It is first before history and byte-identical across turns and locale
changes. Future volatile facts belong at the end of the latest user turn, outside the prefix.

Fix commits: `df3a12e6` removes localized prose and per-turn prompt injection; `25721046` keeps
compaction history outside the provider system prompt. A locally compacted Chat switched to a
provider retains its checkpoint once in user history before the unsummarized tail; compacted
source messages stay excluded. Provider-side compaction itself remains deferred.

### Follow-up evidence — new / regression envelope

- **New:** one bounded-English/brand/no-execution unit test. Two existing dispatch cases are
  strengthened: local request ordering and actual pi-ai OpenAI-compatible wire over fake fetch.
  Both assert system-byte equality across two turns with an English-to-Russian locale change.
  The wire case also checks exact sole system content, checkpoint count/order, retained tail,
  excluded compacted source, secret-canary exclusion and no invented token ceiling.
- **Affected envelope:** 69/69 passed, no skips, across `connections/chat-provider.test.ts`,
  `native-agent/agent.test.ts` and `native-agent/sandbox.test.ts` at `df3a12e6`: one new case /
  68 existing cases. After the compaction fix, all 17 chat-provider cases passed again at
  `25721046`; native-agent production/test files did not change in that fix.
- `npm run typecheck` passed again at `25721046`, all workspaces. ESLint passed for every
  changed TypeScript file. Markdown/link checks passed, including the final hand-off.
- Separate read-only reviewer found no issues in the orientation correction, then independently
  confirmed the checkpoint aggregation defect: the adapter joined all historical system messages
  into its system prompt. The separate fix `25721046` closes it with direct fake-wire assertions;
  the reviewer confirmed closure with no further findings. No live access or heavy review checks.

### Follow-up full gate — failed, recovery required

The requested command ran with Node 26, ports 5236/4436 and isolated `.lane-data`:

```bash
/Users/yuzuru/.local/bin/agent-dev run --cwd /Users/yuzuru/Projects/Guanxi-lanes/chatmodels --node 26 --resource heavy --lock-timeout 3600 -- npm run test
```

Receipt: `/Users/yuzuru/.local/state/agent-dev/check-j5b0cybf/result.json`; sibling `output.log`.
It reports `ok: false`, exit 1, no timeout, clean HEAD
`25721046b3280144bbfc080f9971b5c108723d82` before/after and `source_changed: false`.
The pre-existing unsupported `.claude/skills/guanxi-ui` symlink still prevents reusable source
attestation. The run passed UI fast/codemod/gate tests, then failed exactly one server/CLI case:
`external-agents/admission-reconcile.test.ts:53`, “a dead owner's running group is killed only
when its start time proves it is ours, then the holder is released”. It expected an empty holder
list but observed `cleanup_unconfirmed` / `group_timeout`. Two Linux-only cases were skipped on
macOS. Later kernel/web/UI/bench phases did not run; no whole-suite pass is claimed.

The full reconciliation file passed 9/9 in an immediate isolated Node 26 rerun. No file in that
subsystem changed in this correction. A timing hypothesis remains unproven: the fixture creates
an orphan, awaits another child's exit, then records `Date.now()`; the provenance probe accepts
only a five-second difference from the process's real start time. This is an investigated
failure, not a known-flake exemption. The same reason also covers an unreadable process probe
or unconfirmed group termination; the log does not distinguish these causes. Independent
read-only review confirmed that this test does not exercise the correction's prompt path.
No unrelated production fix, weaker assertion or timeout
increase was made. An earlier queued full command was stopped before launching tests to apply
the independently verified compaction fix; it supplies no gate evidence.

Recovery / next unfinished work: the integrator or K5 owner should reproduce the reconciliation
failure under the full envelope, verify process-start provenance/fixture timing and fix any
confirmed defect separately, then rerun the exact locked full command above. Review of this
prompt correction can proceed; integration still requires a green full gate. No web source
changed in this follow-up, so browser/build evidence below belongs to the original delivery.

## Migration and recovery

Append-only K3 migration 3 adds `dotenv_imports`. Legacy schema and user data paths are unchanged.
Keep the sidecar and OS wrapping keys. Do not downgrade to a binary that cannot parse provider
connections/selections. Root changes create a new connection rather than redirecting existing Chats.
Boot import leaves the interactive vault unlocked; standalone CLI closes it on disposal.
Restart a running node after a standalone import to register newly stored current/retired keys.
Concurrent imports serialize inside one registry; separate CLI processes can require retry after
an identity/SQLite conflict. No plaintext digest or key fingerprint is exposed.

## Evidence — new

Original delivery: 24 new tests (16 server, 2 CLI, 5 picker and 1 Settings-host assertion).
Follow-up evidence is counted separately above.

- Dotenv literal substitutions/quotes/comments, ignored unknown keys, idempotence, rotation,
  same-process concurrency, root identity, fixed errors and generated canary scans across
  import results, console methods, connection snapshots, SQLite/WAL, history, durable input/events.
- URL validation, discovery deduplication/source/time/cache, catalog fallback, locked/keyless/service
  exclusion, pinned compatible dispatch, escaped target refusal and unknown custom prices.
- Split/overlapping key redaction, fake provider durable SSE after disconnect, one assistant/receipt,
  locked-vault replay and conflicting replay, explicit Stop, fresh-owner interrupted recovery.
- Local/provider prompt dispatch and scrubbed context; these prompt assertions are superseded
  by the stronger English baseline checks above. Real pi-ai wire over fake fetch streams without
  borrowing an unrelated model's output ceiling.
- Provider-only picker, local fallback, no provider prewarm, Agent switch payload, quiet refresh,
  same-name connection group counts/ancestry, Settings host without API-root path.

Targeted commands passed: `node --test packages/server/test/connections/chat-provider.test.ts
packages/cli/test/connections-import.test.ts` (18/18); web Vitest picker + Connections files
(27/27: 6 new, 21 existing assertions); existing K3 model-access regressions (50/50).
Combined targeted evidence: 24 new / 71 existing regression tests. These use generated fake keys,
throwaway stores/keychains and fake transports; no live authentication or provider quality is implied.

## Evidence — original regression envelope and gates

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
- The Chat orientation is the ADR-0021 baseline, not a new D-208 prompt. Any expansion requires
  an ADR-0025 bench result. No quality, benchmark non-inferiority, cache-hit measurement,
  production validation, full UI visual approval or invoice reconciliation is claimed.
- The follow-up full gate failed external-agent reconciliation; see its receipt and recovery
  steps above. Isolated success does not replace that failed envelope.
- UI redesign integration must preserve the generic groups/selection contract. Existing legacy
  Select receives data grouping only; no catalog component/review status or CSS was changed.
  Catalog search found `select` still draft, so no new product use was introduced.

## Shared edits and commits

Shared seams: contract connections; CLI bin/export; server index/context, legacy turn loop,
thread/project routes/admission, Job lookup, vault comparison and runtime lifecycle docs;
web legacy Select, ChatPage/resource-conflict hook, API client and Connections host/locale strings.
No PHASE_STATUS/NEXT_AGENT_PROMPT, unrelated lane, generated asset, license or dependency edits.
The correction also shares the native-agent orientation source; its native variant is unchanged.

Commits before handoff: `6f89f3d0` plan; `947baf32` implementation; `d269779b` provider admission;
`2fc52628` tests; `cb5abc1b` input/fallback fixes; `d7244005` review fixes, wire assertions/docs/smoke;
`b6a15eb1` secret-bearing root fix; `4fc72aa5` quiet refresh; `388f210c` group identity;
`7fb16210` Settings-host test; `23adfcbe` migration regression fixture. Final docs-only commit contains this evidence file.
Follow-up: `df3a12e6` ADR-0021 correction, `25721046` checkpoint-prefix fix, followed by a separate
hand-off-only commit recording the focused passes and failed full gate.
