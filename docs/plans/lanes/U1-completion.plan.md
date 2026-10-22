# U1 completion — first slice: signed layout replication

**Status:** authorized implementation in progress · **Date:** 2026-10-21
**Branch:** `codex/u1-completion` · **Starting candidate:** `0523f9b`, main `1067a04`
merged as `f8cc73b`. Runtime: current Mac, Node 26, ports 5199/4399, disposable `.lane-data`.

## Acceptance review of the existing U1-a candidate

Independent from the original author: all 21 selected layout/boundary/keyed-slot Node tests
and all 18 workspace Chromium cases passed on the source after the documentation-only main
merge. Receipts: `check-l0c3u_0w` and `check-p8q05ocy` under the shared agent-dev state.
The browser cases assert keyboard movement/live text, F6, retained pane identities across
float/popout, mode/density preservation, phone priority order and a 30-pane restore budget.
They use mocked APIs and non-executing Terminal/Browser drafts; no live services, hardware or
screen-reader speech are inferred. Real cross-node delivery was absent, despite local LWW
tests using the word replication. U1-b/c and U2 Electron remain separate unfinished scope.

## Objective and implementation boundary

Complete U1-a's portable layout replication through the existing F1 signed, same-account
configuration transport. Keep the accepted document and LWW order `(rev, updatedAt, device)`.
Accept an operation and apply its layout/recovery projection in one SQLite transaction; no
second unsigned transport, asynchronous dual write or in-memory-only handoff. Preserve named
layout activation deterministically across delivery order, and never replicate window geometry.

- Contract: a strict layout config value, node account context for browser layout requests,
  and a minor-version feature boundary that refuses incompatible peers rather than omitting
  signed dependencies from history.
- F1: account/key validation before admission; shared accepted-operation callback inside the
  existing transaction; layout state uses the accepted document clock rather than generic HLC.
- Layout persistence: retain current component-owned schema and atomic recovery deduplication;
  expose an explicit apply-within-transaction path for trusted F1 admission. Normal local mode
  retains its existing behavior. The configured federation service owns the replicated facade.
- REST/client: use the facade when federation is enabled, discover the node-owned account
  before loading workspace documents, and retain the existing error/retry presentation.
- Tests: two independent node stores exchanging through authenticated FederationChannel and
  routes; partition/concurrent saves, both delivery orders, duplicate replay, exact recovered
  loser count/content, restart, mode/account isolation, activation convergence, invalid account
  and tampered signature rejection, rollback, and absence of geometry from exported operations.

## Risks, compatibility and verification

Operations remain durable after acceptance. Projection errors roll back the operation, clock
and layout together. An equal writer clock with different content remains a conflict. Geometry
is local and unmodified by inbound configuration. Existing global migrations are untouched.
No live database migration/backfill is performed; existing local layouts join replication when
saved through the configured node. Rollback may disable the facade and leave its additive
layout tables/config history intact; a future forward migration must preserve that history.

Run targeted layout/federation tests and contract/server/web typechecks first, then ui:check,
full browser gate for the client change, full npm test, UI browser gate, build, Markdown and
license gates under repository rules. Heavy checks run sequentially through
`agent-dev --resource heavy`; never kill another lane's process. Source receipt limitations
from the existing external skill symlink remain explicit. No models, owner data or external
pages in tests.

Commit the bounded implementation before a separate reviewer checks it; repair findings in
separate commits. Root coordinates independent review and integration. Only lane handoffs are
updated here; never edit central trackers or push/merge into main.

## Following slices

After U1-a acceptance and replication integration: U1-b navigation/status/palette/new-session/
side-chats/glossary, then U1-c file-by-file migration to zero suppressions. Fully specified
mechanical U1-c batches can be delegated by the coordinator to DeepSeek; product behavior and
new UI primitives require their own catalog, browser and independent acceptance evidence.
