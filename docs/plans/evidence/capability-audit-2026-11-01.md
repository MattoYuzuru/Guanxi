# Runtime capability audit — 2026-11-01

**Status:** source audit at `af254dae`; current-state documentation reconciled. This is not a
runtime or stage-exit verdict. Scope: V1/V2 voice, C1/C4 browser, WG1/WG2 work and X1 indexing.

The audit checked production imports, node boot, routes, contracts, tool registration and UI
composition against subsystem READMEs and dated handoffs. It used this Mac only, with no live
model, audio, provider request, browser profile, tracker write or remote host. Independent
workers inspected the voice/browser and work/indexing areas; the integrator owns subsequent
implementation, review, status updates and CI.

## Observed integration boundaries

| Capability | Implemented and connected | Missing product path or evidence |
| --- | --- | --- |
| V1 glossary | `guanxi.voice`, `voice.sqlite`, `/api/voice/glossary`, settings editor, account/project terms, history, revert and replacement preview | Actual audio transcription is not part of these routes |
| V1 STT/dictation | Standalone loopback whisper.cpp adapter, biasing planner, deterministic replacement and voice-origin helpers | Registered STT service/connection, transcription API, capture, composer integration and agent-facing marker delivery; real quality/latency evidence |
| V2 learning | Pure evaluation and pre-apply comparison functions; glossary revisions can record a candidate source | Candidate collection/store, `voice.flag_term`, review queue and automatic apply/revert loop |
| C1/C4 browser | Pure origin decisions and SQLite site-grant/context metadata | Browser host, contexts/leases, streamed pane, takeover, routes/tools, encrypted sessions, Bridge extension and grant UI |
| WG1 ledger | `guanxi.work`, `work.sqlite`, `/api/work`, revisions, derived items, mode and on-demand Markdown export | Board UI, `work.query` tool, broader execution integration and WL-series evidence |
| WG2 tracker sync | Internal GitHub Issues/Jira adapters, injected transport, coarse transitions, comment markers and rate-limit/deferral logic | Runtime plugin, configured links, durable link state, credential UI, polling scheduler and live service evidence |
| X1 indexing | Booted project-index plugin, tracked native roots, repository maps and native search; IX0 literal search, IX1 tree-sitter and IX2 FTS | IX3 embeddings, localisation speedup evidence and X2 A/B |

Source entry points:

- [`index.ts`](../../../packages/server/src/index.ts) loads `projectIndexPlugin`, the optional
  voice/work plugins and the glossary/work routes. Voice/work sidecars may be unavailable if
  their optional plugin failed; a source registration is not an availability observation.
- [`voice/plugin.ts`](../../../packages/server/src/voice/plugin.ts),
  [`voice/routes.ts`](../../../packages/server/src/voice/routes.ts) and the
  [voice wire contract](../../../packages/contract/src/voice.ts) provide glossary operations.
  The [editor](../../../packages/web/src/features/voice/GlossaryPage.tsx) uses those endpoints.
- [`WhisperServerAdapter`](../../../packages/server/src/voice/stt/whisper-server.ts) has no
  production caller. The [native prompt writer](../../../packages/server/src/native-agent/service.ts)
  accepts typed/queued origins; the voice enum value alone does not wire marker delivery.
  The [desktop permission boundary](../../../packages/desktop/src/security.ts) denies media.
- [`browser/`](../../../packages/server/src/browser/README.md) has no production host/import
  outside its own library. The
  [workspace Browser pane](../../../packages/web/src/features/workspace/Workspace.tsx) keeps
  an address draft and explicitly says it does not navigate.
- [`work/routes.ts`](../../../packages/server/src/work/routes.ts) exposes ledger APIs;
  [`work/sync/`](../../../packages/server/src/work/sync/README.md) is not called by them.
- [`indexing/plugin.ts`](../../../packages/server/src/indexing/plugin.ts) provides
  `project.index`; [`native-agent/tools.ts`](../../../packages/server/src/native-agent/tools.ts)
  exposes `repo_map` and `search`. Optional LSP servers can improve maps when available in
  the execution environment; their presence is not assumed.

## Quality and trust boundaries

The [V1-d handoff](../lanes/V1-d.handoff.md) records fake-server protocol and biasing checks,
not a real model or recognition-quality result. The
[glossary UI handoff](../lanes/V1-glossary-ui.handoff.md) records mocked node/browser flows;
production matcher/store behavior is covered separately by server tests. The
[V1-c handoff](../lanes/V1-c.handoff.md) records scorer tests, not an audio corpus.
`compareEval` refuses synthetic evidence for both V1 and V2 decisions. Tests that label
constructed text as `owner_recording` exercise that function's branches; they are not the
owner's recordings. The V1 term-F1/U-WER gate is unevaluated.

The adapter's 448-character prompt budget uses an explicitly unverified token approximation;
there is no real tokenizer measurement. No on-device or cloud STT adapter is implemented.
The voice-origin structure and block are library helpers, not a completed capture-to-agent
privacy or delivery path. D-157's seven-day audio-retention policy remains a target for that
future audio path.

The [C1-a/C4-a handoff](../lanes/C1-a.handoff.md) records origin-policy and metadata-store
tests. `via` and `fromOrigin` remain trusted-host assertions. The policy permits readable-origin
clicks in Read-only mode, so the future host must prevent form-submitting clicks. Grant
revocation returns context IDs but does not close a Chromium context; the live TTL invariant,
planted-cookie secrecy and injection containment are not demonstrated by these unit tests.

The [WG2-a handoff](../lanes/WG2-a.handoff.md) records authored API fixtures, inspected outgoing
requests and review fixes. It does not establish live GitHub/Jira compatibility or configured
production synchronization. WG2 covers Issues and coarse comments/labels or Jira transitions;
Git operations, pull requests and Actions are separate capabilities. Business fields remain
tracker-owned under D-171; no broader write surface is inferred from an adapter class.

The [indexing README](../../../packages/server/src/indexing/README.md) describes actual
runtime registration, privacy exclusions, sandboxed workers and freshness observations.
Embeddings are absent even if the inert setting is enabled. An implemented index is not
evidence of a measured agent-quality or localisation speedup.

## Next bounded engineering slices

These are implementation recommendations, not new owner decisions or revised stage gates:

1. **V1:** connect local transcription to an editable draft. Wire an adapter service/config,
   request/response contract, cancellation and content-free failures; then capture/review and
   composer controls with explicit microphone permission. Preserve the separate user Send
   action. Use synthetic fixtures for wiring, and owner recordings for subsequent quality
   evaluation. A glossary preview alone does not close dictation.
2. **C1 before C4:** implement the ephemeral browser host with per-run ownership, navigation
   provenance, egress, cancellation and actual Read-only enforcement before importing sessions.
   Connect a visible pane and a scoped agent surface in bounded follow-ups. Bridge/session
   transport then needs encrypted storage, per-site grants and live revocation tests.
3. **WG1/WG2:** expose the existing ledger through its board/tool boundary; wire tracker sync
   behind a scoped plugin with persistent links and the D-175 scheduler. Keep the existing
   business-field write protection. Test transport and crash recovery before live tracker
   evidence. Changes to agent tools follow the existing ADR-0025 benchmark protocol.
4. **X1:** reuse the registered index rather than reimplementing repository navigation. Keep
   embeddings behind the D-169/X2 evidence path.

No new blanket consent is needed for local implementation. D-157 already sets audio retention,
owner recordings and default cloud-glossary privacy; D-178/D-179/D-181/D-182 already set Bridge
distribution and site-control boundaries. D-171–D-175 and D-169 already settle the corresponding
tracker/indexing choices. This audit does not close questions or replace the owner's decisions.

Later operational inputs/evidence are concrete: owner audio with corrected references and
technical terms; a configured real STT runtime/model for evaluation; project-to-tracker mapping
and securely registered credentials; an appropriate disposable issue for live write validation;
pilot site/account grants and owner-interactive login/2FA/passkeys; and the publisher access
needed for the already planned Chrome Web Store release. Cloud STT/glossary transmission, if
selected later, uses that connection's consent. None of these missing assets proves that
unrelated local implementation is blocked.

## Documentation correction and validation scope

Updated the voice overview to distinguish glossary wiring from the isolated STT library,
preserved per-slice matching/scoring rationale, removed stale "adapters later" claims and
named the missing dictation path. The browser README now distinguishes metadata decisions
from live enforcement. WG1 documentation records its existing boot/REST wiring and the current
global authorization hook while preserving the same-host human-attribution residual. WG2
documentation states its narrow adapter surface and absent runtime integration.

**New runtime tests:** 0. **Regression envelope:** not rerun for this documentation-only
correction. Source inspection and `git diff --check` are the local checks; the integrator runs
documentation lint/link checks, independent review and the required final hosted candidate
gate. Historical handoff counts and results above remain dated evidence, not new validation.
