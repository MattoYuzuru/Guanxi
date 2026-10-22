# Private trial channel protocol foundation

**Status:** implemented, independently reviewed and locally fixture-validated. This is
a codec and state machine; the [private process binding](PRIVATE_PROCESS.md) now supplies an
executable child over anonymous inherited FDs. No socket listener or task image is added.

Frames contain a four-byte unsigned big-endian payload length followed by one UTF-8 JSON
value. The host supplies an explicit payload-byte ceiling. Decoding tolerates arbitrary
byte/chunk boundaries and refuses oversized announced lengths before allocating their
payload, invalid JSON/UTF-8 and truncated EOF. A framing error closes that decoder.

Version 1 requests contain only `id`, `operation: "complete"` and a text/tool transcript.
The transcript accepts system/user text, assistant text/tool calls and tool results, plus
JSON tool declarations. Images and reasoning fields are unsupported by this text benchmark
protocol and refused explicitly. Account, connection, model, trial, output policy and
credentials are never request selectors. The coordinator constructs the channel around one
reviewed immutable trial gateway and catalog identity. Historical assistant usage values in
the generated model context are placeholders only; they never settle or verify billing.

The host supplies explicit request-count and per-request timeout policies. Duplicate IDs,
foreign fields, unsupported operations, excess requests or concurrent requests close the
capability before another gateway call. A close or timeout reaches the active gateway's
abort signal. `settled()` waits for that operation's acknowledgement; it does not claim
uncooperative code has stopped merely because a timer expired. There is no automatic retry.

A successful gateway completion must pass through the host's private retention port before
the task gets a response. The production host provides the optional trusted
`retainAndProject(requestId, result)` port: it scrubs the full completion, durably appends a
begin receipt and the ordered content through the fenced K2 sink, appends the done receipt, and
returns the public projection derived from the stored scrubbed events. The channel writes
exactly that returned projection. The older pure `retain` host API remains supported for
in-memory fixtures, but it cannot provide the production same-projection guarantee. Only
assistant text, tool-call IDs/names/arguments and stop reason enter the response. Thinking
blocks, signatures, usage objects, receipt metadata and provider credentials are omitted. The
module writes no log or trajectory. Gateway errors are mapped through a fixed code list;
retention, framing or other failures close the channel and expose a fixed error frame.
[PRIVATE_PROCESS.md](PRIVATE_PROCESS.md) describes the real K2 sink and process binding; no fake
sink is used in the production composition.

An empty completion is a normal successful completion: it still produces a fenced begin and
done receipt and the empty public message, so it cannot bypass the R1 retention fence. A
canceled/deposed attempt fails the begin append and produces no success frame. The stored stop
reason is read from the acknowledged begin receipt rather than the fresh gateway result. A
changed same-key completion, removed/reordered tool or private specification, partial-prefix
mismatch, purged receipt or legacy no-receipt trace fails closed; the channel exposes only its
fixed `channel_failed` code. The private sink's correlation span is derived from the binding
nonce and request id, so two bindings sharing a session and request id do not conflate.

The transport owner must bound read buffers, validate peer identity, call `close()` on
EOF/disconnect and await `settled()` before releasing trial ownership. No Unix peer checks,
Podman mounts, process supervision, startup capability transfer, Python mini-swe-agent
client, native-agent remote K3 port or real image is implemented here. Those are separate
prerequisites; a caller must not turn this pure module into a generic K3 endpoint.

The separate [stream adapter](PRIVATE_STREAM.md) now binds coordinator-owned Node streams to
this protocol. It does not supply process supervision, peer checks or an executable endpoint.

The ten local synthetic tests cover split/coalesced UTF-8 frames, invalid/oversized/truncated
frames, strict request identity, replay/quota/byte limits, private retention before output,
reasoning omission, close/timeout/concurrent cancellation and acknowledged settlement.
They do not measure a model, public corpus, operating-system peer boundary or paid budget.
