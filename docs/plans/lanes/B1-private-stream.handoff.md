# B1 private stream continuation

**Status:** implementation and author focused checks complete; independent review pending.
**Date:** 2026-10-22. Branch `codex/b1-private-process`, base `7d5d704`.
Local Mac, Node 26, synthetic in-memory streams only. No SSH, remote runtime or paid inference.

This bounded slice adds `servePrivateTrialStreams`, an owned-stream binding for the independently
reviewed private protocol and immutable gateway. A readonly `PrivateTrialChannel.isClosed`
observation lets a channel error finish its fixed frame before closing transport. No REST wire,
database, process creation, Unix socket, image or K3 credentials change.

The input event path remains active across gateway, retention and output awaits. EOF during
gateway/retention closes and aborts immediately, then waits for its acknowledgement before
releasing ownership. Concurrent complete requests cannot queue another model operation. Clean
EOF during already-retained output delivery may finish that write under explicit host timeout.
Payload/chunk/request/time policy is explicit and captured; output waits for Writable callback,
handles backpressure/failure/late callbacks and returns only fixed transport reasons. The
result counts acknowledged writes, not task success or peer receipt. No plaintext log is written.

See [the stream contract](../../../packages/bench/PRIVATE_STREAM.md) for limitations, including
upstream allocation responsibility and inability to revoke bytes handed off before cancellation.
Real process ownership, peer identity, K2 persistence, mini-swe/native clients, image, verified
settlement reporting, five-seed flow and actual fresh50+Verified30 staging remain unfinished.
The explicit corpus freshness prerequisite and disabled stock paid executor are unchanged.

Author checks: **10 new / 10 protocol regression envelope, 20/20 pass, zero skips**, local
receipt `check-byzfce9z` at the uncommitted source candidate. Earlier bench TypeScript check passed;
final source check and independent review are recorded in a follow-up before integration.
No new full bench/connection, mutation, browser or operational gate is claimed. Historical B1
131-case evidence remains attached to its original pinned source in the B1 completion handoff.

Independent review must focus on input closure during host awaits, acknowledgement before
ownership release, half-close during output, one in-flight operation across writes, explicit
output timeout/late callbacks, fixed errors and no plaintext output. Root owns integration and
central status updates. This slice does not close B1 or authorize real experiments.
