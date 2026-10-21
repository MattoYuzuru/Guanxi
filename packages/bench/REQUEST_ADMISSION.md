# Request admission foundation

**Status:** implemented and fixture-validated. This is the first B1 execution
continuation slice, not an operational paid executor or a measured benchmark result.

The whole-experiment `Budget.reserve()` remains the protected D-150 boundary: it reserves
every trial's worst case before an executor starts, with the $200 monthly, equal per-arm
and provider daily-token limits. Per-request admission consumes that envelope without
charging it a second time.

## Order and ownership

1. The trusted coordinator reserves the validated experiment. This transaction also records
   immutable trial identities, model and trial limits in the same private benchmark ledger.
2. A K3-owned bridge pins an explicit output-token limit and installs
   `preparedRequestAdmission(...).onPrepared` as the existing `ModelCall.onPrepared` hook.
   K3 calls it after scrubbing and before provider dispatch. Both Guanxi and mini-swe-agent
   must eventually use this same bridge; neither task container receives a provider key.
3. A trusted provider-specific adapter quotes the exact prepared-request digest. It must
   prove an upper input-token bound that includes every provider serialization/normalization
   overhead and an enforceable provider output limit. A digest of K3 context alone does not
   prove a provider token bound. The bridge must pass the same explicit output limit to K3.
4. The quote includes provider/model, meter and price source/version, observation and validity
   times, verified confidence, USD input/output ceiling rates and any per-request fee. The
   input ceiling covers all input/cache billing categories. Independently billable categories
   round upward using integer arithmetic. Unknown, unverified, expired or future observations
   refuse admission; there is no built-in price table or guessed zero-cost fallback.
5. `Budget.admitRequest` commits a unique request's worst-case money/tokens/step debit in a
   SQLite `BEGIN IMMEDIATE` before the hook returns. The remaining trial cost, token and step
   ceilings are checked independently. Quote freshness, run deadline and UTC budget day use
   one clock sample after acquiring the transaction, so another writer's lock wait cannot
   preserve expired admission authority. There is at most one unsettled request per trial.
6. After dispatch, `settle` records verified usage with source and observation time. A smaller
   observation does not refund the quote. Unknown usage or a bound breach keeps the hold and
   halts that trial; a breach also returns `request_bound_violated`. An unsettled crash hold
   blocks further requests on that trial after restart. No request ID may dispatch twice,
   including by switching arms. Other trials keep their own equal ceilings.

The hook is trusted host code, not a wire API, model tool, credential or authority granted to
an agent. The bridge, price source and provider meter are responsible for their assertions.
This slice ships **no real-provider quote adapter or cross-process arm bridge** and does not
make the stock executor `boundedBilling`. The existing stock refusal of paid/A/B/noise-floor
execution remains in place. K3's existing generic error mapping may report a refused hook as
`provider_failed`; the gateway owner retains the local admission cause. No new REST field or
public error code is introduced by this slice.

## Persistence and recovery

The benchmark SQLite ledger gains `request_runs`, `request_trials` and
`request_reservations`; no shared node migration is changed. Existing whole-run holds remain
charged. A historical run with no request-registration rows cannot gain dispatch authority
by reopening the ledger. A settled run, its UTC budget day boundary or its recorded deadline
refuses new requests. There is no automatic refund, same-ID retry or inference recovery.

The ledger stores identities, quote provenance, token/cost ceilings, states and verified usage;
it never stores the prepared prompt, tool results or reasoning. The SHA-256 binds the quote
to the exact prepared value without persisting that value. All benchmark processes for the
same account must share the same ledger as before; a second ledger is not a budget bypass.

## Verification and remaining B1 work

New fixtures exercise both arms' equal envelopes, independent money/token/step refusal,
cross-handle crash holds, unknown/breached usage, replay, foreign identities, stale/unknown
pricing/metering, output/digest mismatch, deadline/day/settled-run refusal and integer bounds.
A separate SQLite writer holds admission across a clock boundary; quote, run-deadline and
UTC-day expiry each assert zero request debit and zero dispatch after the lock is released.
One real K3 fixture uses a throwaway in-memory wrapping key and fake transport: it proves
scrubbing happens before the hook, the durable hold exists before transport and the refused
next request never dispatches. It uses no live model, actual credential or network.

Still required before paid execution: audited provider-specific wire/token/price adapters,
the K3-owned endpoint shared by both arm bridges, immutable corpus staging and hidden
verifiers, prepared Guanxi task images, actual seed transport, bounded real orchestration,
independent review and the coordinator's experiment-specific go-ahead. A real five-seed noise
floor and 50-fresh/30-regression A/B run have not been measured by these fixtures.
