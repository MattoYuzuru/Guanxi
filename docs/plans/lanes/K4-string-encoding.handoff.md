# K4 bounded string encoding — handoff

**Status:** bounded implementation locally validated for the pure encoding envelope only,
including the standalone marker-only repair. The real helper/filesystem/native envelope and all
full gates remain root-owned and unrun here. Independent GPT review follows the clean source
pin. This is not K4, stage-closure or MS1 completion, and it does not claim total bounded memory
or an RSS ceiling.

**Date:** 2026-10-22
**Branch:** `codex/k4-string-encoding`
**Base:** `0d19c1c5fe3bfe80f6766abbbb2f962d05039410` (authorized clean launch HEAD)
**Source pin:** `f770c765bd39873cf31488e96d48615928dd6455` (marker repair; prior executable
source `68eacdfdf5ee0e5c66584c67f747bc0db1b03d08`)
**Repair base:** `281f1fcddc6d27ec3144f534d9c4d87c997e7865` (clean independent-review pin)
**Handoff pin:** the docs commit containing this file. The exact `git rev-parse HEAD` and an
empty `git status --porcelain` are reported after that commit; no source edit follows it.

## Authorization and clone binding

The root-authored contract is
[`K4-string-encoding.plan.md`](K4-string-encoding.plan.md). This clone was prepared from the
independently reviewed U1/K4 privacy union `aa878593`; root's own offline `npm ci` passed
`check-5v7wilx3`. At launch this clone had clean HEAD `0d19c1c5`, absolute git dir
`/Users/yuzuru/Projects/Guanxi-lanes/k4-string-encoding/.git`, branch
`codex/k4-string-encoding`, Node `v26.9.0`, and `@guanxi/contract` resolved to
`/Users/yuzuru/Projects/Guanxi-lanes/k4-string-encoding/packages/contract/src/index.ts`.

## Outcome

- `SessionInputStore.write(string)` hashes the immutable string through a restartable UTF-8
  iterator bounded to the existing 64 KiB transport chunk, then gives the pinned helper a
  fresh iterator as its `content`. No full `Buffer.from(text, 'utf8')`, full
  `TextEncoder.encode(text)`, joined chunk array or whole encoded copy is used.
- Every yielded transport chunk owns an unpooled `Buffer` backing allocation. A full chunk is
  the allocated buffer; a final partial chunk is the last view of a buffer the iterator never
  reuses. The iterator never mutates a chunk after yielding it.
- The first hash pass necessarily encodes bounded chunks before the helper. Only the transport
  iterator is deferred: it is not pulled until the pinned helper's `cwd`/`dev`/`ino` identity
  handshake is validated. This handoff does not claim zero encoding before that handshake.
- `utf8Excerpt()` scans only the requested UTF-8 prefix. A complete fitting value is returned
  unchanged, preserving lone surrogates. A truncated value equals the previous UTF-8-safe
  prefix except that a partially included redaction marker is dropped whole; no marker is
  split. A zero bound is valid; negative, fractional, non-finite or unsafe bounds fail with a
  content-free `SessionInputError` code `invalid_input`.
- SHA-256, `byteSize`, stored bytes, `(sessionId, checksum)` dedupe, helper protocol, file
  modes, fsync/link/verify, session fences, receipts, cleanup identity and backpressure are
  unchanged. Model-visible bytes remain equal.
- `write(Uint8Array)` keeps its existing snapshot copy exactly. Reads, replay, scrubbing,
  base64 helper transport, provider history and queue events remain whole-buffer.

## Files and commits

| Commit | Scope |
| --- | --- |
| `40d825e8ef19b6f51dc853db5cedc6aa21b0076e` | red-first allocation/excerpt regressions against the old public API |
| `48bc44f2f4da84b83f2e206f5303805c0f63d355` | private bounded encoder, `write`/`utf8Excerpt` integration, module README |
| `743262db17c00f0ff88fb76cc631ce16901e39bd` | independent whole-buffer iterator/hash/excerpt oracle tests |
| `b474d10043114dfa98806373c31c05491fc85821` | real-helper transport ownership, abort and digest-survivor tests |
| `68eacdfdf5ee0e5c66584c67f747bc0db1b03d08` | native multi-chunk Unicode prompt/replay test |

Production files: `packages/server/src/session-log/input-encoding.ts` (new private module),
`packages/server/src/session-log/input-artifacts.ts`, and their
`packages/server/src/session-log/README.md`. No contract, migration, wire schema, shared pinned
helper, egress, native service, UI or dependency file changed.

The optional `SessionInputStoreHooks.onTransportChunk` test seam was added in
`input-artifacts.ts`. It observes a real transport chunk after the verified handshake and before
the yield; production callers do not use it and no payload is logged.

## New / regression envelope

**New in this slice: 16 tests.**

- `packages/server/test/session-log-input-encoding.test.ts` — **11** pure encoding tests:
  allocation guards for write and excerpt, split-marker clipping, complete lone surrogates,
  malformed bounds, whole-buffer chunk/hash oracle tables, chunk ownership/no-mutation, and
  excerpt oracle/marker-boundary tables. This file is new; all 11 are new.
- `packages/server/test/session-log-input-artifacts.test.ts` — **4** new real-helper tests:
  deferred handshake with zero transport pulls, empty-string exact digest, in-flight abort with
  no published digest, and a published-digest survivor after a later failed write. The existing
  directory-swap test is strengthened in place with a zero-transport-chunk assertion; that is
  not a new test count.
- `packages/server/test/native-agent/input-artifacts.test.ts` — **1** new fake-provider test:
  multi-chunk supplementary/BMP prompt exact checksum, stored readback, first model request and
  restart replay.

**Actually run here: 11/11 pure encoding tests, zero failures/skips.** These tests do not spawn
the helper or read a session artifact. The 5 real-helper/native additions above were typechecked
and linted but deliberately not run under this sandbox.

**Regression envelope not run here:** the 23-test session-log input-artifacts file (19 prior + 4
new), the 14-test native input-artifacts file (13 prior + 1 new), the 19 unchanged privacy
tests, and the prior K4 selected server files. No combined total or full regression claim is
made.

The 19 integrated privacy assertions in `packages/server/test/egress-truncated-prefix.test.ts`
and `packages/server/test/session-log-truncated-egress.test.ts` are unchanged. Their append
inputs are raw fixture text without markers; the new marker clipping applies only to a
truncated scrubbed value, so their existing expected behavior is preserved. Root still runs
them unchanged.

## Observed red

At base `0d19c1c5`, with the red-only six-test file written against the existing public API
(`SessionInputStore.write` and `utf8Excerpt`; no new-module import):

```bash
nice -n 10 node --test packages/server/test/session-log-input-encoding.test.ts
# tests 6 / pass 2 / fail 4
```

The four failures were semantic, not import/type failures:

- write allocation guard: a whole `Buffer.from` recorded `1048576` bytes for a 1 MiB string;
- excerpt allocation guard: the same `1048576`-byte whole-input buffer;
- marker boundary: `"aaaaaaaaaaaaaaaaaaaa⟦REDACTE"` instead of the whole-prefix
  `"aaaaaaaaaaaaaaaaaaaa"`;
- malformed bounds: `Missing expected exception` for negative, fractional, non-finite and
  unsafe bounds.

The later `TextEncoder` guard and iterator table were added after that observation; they are
new coverage, not credited as red-first evidence.

## Observed green (this sandbox)

```bash
nice -n 10 node --test packages/server/test/session-log-input-encoding.test.ts
# tests 11 / pass 11 / fail 0 / skipped 0

nice -n 10 npx tsc --noEmit -p packages/server/tsconfig.json
# exit 0, no output

nice -n 10 npx eslint \
  packages/server/src/session-log/input-encoding.ts \
  packages/server/src/session-log/input-artifacts.ts \
  packages/server/test/session-log-input-encoding.test.ts \
  packages/server/test/session-log-input-artifacts.test.ts \
  packages/server/test/native-agent/input-artifacts.test.ts
# exit 0, no output

nice -n 10 npx markdownlint-cli2 docs/plans/lanes/K4-string-encoding.handoff.md \
  packages/server/src/session-log/README.md
# 2 files, 0 errors

nice -n 10 node scripts/check-doc-links.mjs
# checked 191 files, 644 links, 0 problems

git diff --check
# exit 0
```

No `npm ci`, full `npm test`, browser, build, license, `agent-dev`, container, nested sandbox,
live model/provider, SSH, remote, owner-workspace or owner-data command ran. The clone already
had root's offline install; `@guanxi/contract` resolution was verified as above.

## Root commands still unrun

The root should run these unchanged at the clean frozen pin, outside this sandbox. Run the
real-helper filesystem/native envelope under the shared `heavy` lock:

```bash
export GUANXI_WEB_PORT=5189 GUANXI_API_PORT=4389 GUANXI_DATA_DIR="$PWD/.lane-data"

agent-dev run --cwd "$PWD" --node 26 --resource heavy --lock-timeout 3600 -- \
  node --test \
  packages/server/test/session-log-input-encoding.test.ts \
  packages/server/test/session-log-input-artifacts.test.ts \
  packages/server/test/session-log-version-negotiation.test.ts \
  packages/server/test/session-log-routes.test.ts \
  packages/server/test/session-log.test.ts \
  packages/server/test/native-agent/input-artifacts.test.ts \
  packages/server/test/artifacts.test.ts \
  packages/server/test/migration.test.ts \
  packages/server/test/durable-run-migration.test.ts \
  packages/server/test/relay/schema.test.ts

agent-dev run --cwd "$PWD" --node 26 --resource heavy --lock-timeout 3600 -- \
  node --test \
  packages/server/test/egress-truncated-prefix.test.ts \
  packages/server/test/session-log-truncated-egress.test.ts

agent-dev run --cwd "$PWD" --node 26 --resource heavy --lock-timeout 3600 -- npm test
agent-dev run --cwd "$PWD" --node 26 --resource heavy --lock-timeout 3600 -- \
  npm run test:web:browser
agent-dev run --cwd "$PWD" --node 26 --resource heavy --lock-timeout 3600 -- npm run build
```

Also required if the root's full envelope includes them: workspace typecheck, scoped/source
lint, Markdown/link lint and license check. The native `agent.test.ts` nested-sandbox scope
remains root-owned and was not run here.

## Compatibility and rollback

No persisted format, schema, migration, wire version, dependency, UI, permission or retention
change exists. Reverting the five executable commits preserves the same artifact bytes,
digests, references and event shapes; the byte-input snapshot copy and helper protocol are
untouched. Stop if digest, UTF-8 byte identity, byteSize or receipt identity differs; do not
"repair" stored hashes. Pre-migration33 rollback restrictions are unchanged: a pre-v2 binary
still cannot consume a v2-bearing database.

## Residual scope and not claimed

- Reads, replay, scrubbing, base64 helper transport, provider history, byte-input snapshot
  copies and command/queue paths remain whole-buffer.
- `agent.queue.items[].text` remains inline; queue artifactization is not implemented or
  credited.
- No total input cap, total bounded-memory claim, peak-RSS measurement, stage closure, MS1
  exit, platform expansion or production validation is claimed.
- The 64 KiB value is a transport chunk bound, not a total input or memory ceiling. Per-chunk
  and per-allocation assertions are not an RSS ceiling.
- The helper itself still verifies a published blob with bounded reads, but the parent read
  path still returns whole bytes for replay; no read-side streaming contract was introduced.
- Only this macOS arm64/Node 26.9 sandbox ran the pure tests. Linux, Windows, containers, other
  Node versions and the real helper/native envelope are not validated here.
- No live model, provider, browser, container, nested sandbox, SSH or owner data was used.

## Shared edits and review

No shared path outside the owned session-log production files, their README and the three test
files was edited. The optional observation hook changes the exported `SessionInputStoreHooks`
type but not `SessionInputStore` behavior for callers that omit it.

A separate independent GPT review should read the complete diff `0d19c1c5..68eacdf` (and this
handoff), specifically checking: whole-input allocation guards are real and fail on the old
path; transport ownership/no-mutation; zero transport pulls before the handshake and on failed
identity; abort settlement and digest survival; exact Unicode/oracle identity; marker-boundary
whole clipping; byte-input snapshot and read/replay residuals; and that the new tests do not
merely mirror the implementation. No self-certification, approval, merge, rebase or push is
claimed.

## Marker repair — 2026-10-22

Independent review
`/Users/yuzuru/Projects/Guanxi-lanes/reviews/codex-k4-string-encoding-20261022.md` confirmed one
P2 at `input-encoding.ts:168-170`: every unmatched `⟦` in a truncated prefix was treated as a
redaction marker, so ordinary decorative text was dropped. The repair is isolated to the excerpt
boundary classifier.

**Repair commits:**

| Commit | Scope |
| --- | --- |
| `d0f877d69abfc02c0686e465210b7774858f5f06` | red-first tests: plain-bracket oracle cases, explicit known-marker boundaries, complete values |
| `f770c765bd39873cf31488e96d48615928dd6455` | known-marker-only clipping and README clarification |

### Behavior

- An unmatched `⟦` whose immutable original does not continue with the shared `⟦REDACTED`
  keyword plus one space is ordinary text and keeps the prior whole-buffer UTF-8 safe prefix.
- A cut after only `⟦` or part of the `REDACTED` keyword plus its space is recognized with a
  constant `REDACTION_MARKER_PREFIX.length` lookahead into the immutable original, so the whole known
  marker is still dropped. The close search stays inside the bounded excerpt; no full input is
  encoded and no unbounded tail is scanned.
- Complete values, complete markers, lone surrogates, zero/malformed bounds and chunk/hash
  allocation behavior are unchanged.
- The old `excerptOracle` repeated the production broad-delimiter rule; it is now
  `wholeBufferUtf8Prefix`, a TEST-ONLY whole-buffer UTF-8 safe prefix with no marker rule.
  Known-marker positives use explicit bound/expected-value cases instead of that predicate.

### Red at `281f1fc`

Unchanged outside probe
`/Users/yuzuru/Projects/Guanxi-lanes/reviews/k4-encoding-marker-regression-probe-20261022.ts`
(sha256 `f43379b875576dabde5061742745692151d579036d6ace334e655d2c27e208b0`, not edited):
3 tests, 2 pass / 1 fail, receipt `check-kjtgw29y`; the failure is `'A' !== 'A⟦ord'` for
`utf8Excerpt('A⟦ordinary decoration and more', 7)`.

With only the red-first test commit applied to unfixed production:

```bash
env PATH=/opt/homebrew/opt/node@26/bin:/usr/bin:/bin:/usr/sbin:/sbin \
  nice -n 10 node --test packages/server/test/session-log-input-encoding.test.ts
# tests 14 / pass 12 / fail 2 / skipped 0
```

Both failures are semantic ordinary-prefix failures (`'A'` vs `'A⟦'`, `'x'` vs `'x⟦'`);
known-marker positives and complete-value controls passed at the unfixed source.

### Green at `f770c76`

Same explicit Node 26.9.0 PATH under `nice -n 10`:

```bash
node --test packages/server/test/session-log-input-encoding.test.ts
# tests 14 / pass 14 / fail 0 / skipped 0

node --test /Users/yuzuru/Projects/Guanxi-lanes/reviews/k4-encoding-marker-regression-probe-20261022.ts
# tests 3 / pass 3 / fail 0 / skipped 0

./node_modules/.bin/tsc --noEmit -p packages/server/tsconfig.json
# exit 0, no output

./node_modules/.bin/eslint \
  packages/server/src/session-log/input-encoding.ts \
  packages/server/test/session-log-input-encoding.test.ts
# exit 0, no output

./node_modules/.bin/markdownlint-cli2 packages/server/src/session-log/README.md
# 1 file, 0 errors

git diff --check
# exit 0
```

Counts: this repair adds **3 pure tests**; the pure file now has **14** (11 prior slice + 3
repair). The prior slice's **16 new** (11 pure + 4 real-helper + 1 native) and **51 inherited**
(19 store + 13 native + 19 privacy) are unchanged. The 4 helper + 1 native additions and the
19 privacy assertions were not rerun here. If root reruns the full selected envelope after this
source change, the expected new count is 19 and the envelope 70; this handoff does not claim
that run.

### Evidence scope

Changed files: `packages/server/src/session-log/input-encoding.ts`,
`packages/server/test/session-log-input-encoding.test.ts`,
`packages/server/src/session-log/README.md`, and this handoff. No shared
egress/private-projection/store/protocol/transport/hash/byte-input-snapshot/fence/native/UI/
schema/dependency file changed; the 19 privacy assertions and the outside ownership probe
(`check-djqqmkc8`, 2/2) are untouched. The reviewer's observed envelope `check-_9_j6_zi`
(67/67 at `281f1fc`: 16 new / 51 inherited) remains the reviewer's evidence at that pin, not a
certificate for this commit.

DSH ran only the pure encoding tests and the unchanged pure outside probe. No helper,
filesystem, native, process, browser, build, install, container, nested-sandbox, model,
provider, network, SSH, owner-workspace or owner-data command ran. The original outside probe
is unchanged for independent recheck. No total bounded-memory, RSS, whole-K4 or MS1 claim is
made.

The repair diff to review is `281f1fc..f770c76`; the complete slice diff is
`0d19c1c5..f770c76`. No approval, merge, rebase, reset, push or main/PHASE/NEXT/roadmap change
is made.
