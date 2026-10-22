# Private trial stream adapter

**Status:** implemented and locally fixture-checked; independent review pending.

`servePrivateTrialStreams` binds the [private protocol](PRIVATE_CHANNEL.md) to one pair of
coordinator-owned Node byte streams and an existing immutable trial host. It creates no
process, socket listener, image, authentication boundary or provider configuration. No task
input can select a connection, model, credential, trial or output policy.

Host policy explicitly supplies payload/request/time limits, a maximum delivered input chunk
size and an output-delivery timeout. Policy is captured before asynchronous work. The decoder
allocates at most its explicit payload ceiling; chunks above the separate chunk ceiling are
refused. The caller must construct unused byte streams with appropriate allocation and
high-water marks. This adapter cannot undo an upstream allocation or recover bytes previously
consumed by another reader. Strings and object-mode values are refused.

Input remains observable during inference, private retention and output delivery. A second
complete request while any of those phases is pending closes the capability without queuing
another dispatch. EOF during inference/retention immediately aborts the channel and suppresses
the response, while the returned promise waits for accounting/retention acknowledgement. Parent
abort, input errors and premature closes use the same ownership discipline. Truncated EOF is a
framing failure. No timer is taken as proof that uncooperative host work stopped.

Once gateway settlement and private retention have completed, clean input EOF may half-close
the connection while its response finishes writing. Every write waits for the Writable callback,
with the explicit output timeout bounding stalled delivery. Output error/close, timeout or parent
abort cancels that wait, destroys both streams and preserves the first fixed transport reason.
Late write outcomes are consumed. Already-handed-off bytes cannot be revoked by later
cancellation. `responsesDelivered` counts acknowledged Writable callbacks, including error
frames; it does not prove peer receipt, task success, verified reward or model capability.

A failed channel can finish its fixed error frame and then closes the transport. All output
bytes are protocol frames. The adapter emits no diagnostic text, provider exceptions, reasoning,
stderr or plain log. Only the protocol's public completion fields leave the private retention
boundary. Stream failure need not attempt another frame on the same broken stream.

Ten synthetic tests cover sequential split-byte requests, framed output, private retention,
EOF/parent cancellation and delayed acknowledgement, coalesced concurrency, concurrent input
during a blocked write, clean half-close during delivery, explicit output timeout, late write
completion, fixed channel/stream failures, malformed/truncated/oversized input, foreign selectors,
pre-aborted/closed streams and immutable transport policy. The ten existing protocol tests remain
the regression envelope. No subprocess, Unix peer credentials, container mapping, real K2 sink,
agent client or public corpus was exercised. Those bindings and the real bounded executor remain
unfinished; stock paid execution remains disabled.
