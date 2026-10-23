# V1-d handoff — STT adapter contract and whisper.cpp server adapter

**Status:** implemented, locally validated on `codex/v1d-stt-adapter` against an in-process
loopback fake server. V1 remains in progress; no real model or recordings, so its exit gate is not measurable.

## What exists

- `types.ts`: `SttCapabilities`, `SttRequest`, `SttResult`, `SttAdapter`,
  `TranscribingSttAdapter`, `SttTranscription` (biasing + `VoiceOrigin`), `SttConnection`, `SttError`.
- `whisper-server.ts`: loopback-only whisper.cpp adapter using the shared `loopbackOrigin`
  check. Multipart `POST /inference` (`file`, `response_format=verbose_json`, `language`,
  optional `prompt`), `GET /health`, strict verbose_json parsing, an unverified 448-character
  prompt approximation, confidence only from `avg_logprob`/`no_speech_prob`, V1-a replacement
  and a validated V1-b origin. The exact `transcribeTimeoutMs` runs over `node:http` (no hidden
  300 s fetch cap); HTTP 400 maps to `stt_audio_invalid`; returned language names normalize
  through a small fixed map. No redirects, retries or logging; the 16 MiB response cap and
  10-minute deadline are transport budgets, not audio limits.
- `biasing.ts`: `glossaryAllowed` (D-157), `planBiasing` (canonical terms, deterministic
  folded-key order, whole-term budget, `withheld_no_consent`), `orderedPromptTerms`, `glossaryFingerprint`.
- `packages/server/src/voice/stt/README.md`: API assumptions in one place, evidence, confidence
  formula, D-157 and origin mapping, commands and residuals. `packages/server/test/voice/stt/`
  holds the in-process fake server plus 27 biasing and 44 adapter tests; the tests assert the
  exact form fields, including the absent `prompt` field.

## Commands and evidence

- `nice -n 10 node --test packages/server/test/voice/stt/*.test.ts packages/server/test/voice/*.test.ts`
  -> tests 283, pass 283, fail 0. New: 71 (27 biasing + 44 adapter); existing V1-a/b/c: 212.
- `nice -n 10 npx tsc --noEmit -p packages/server` -> exit 0, no diagnostics.
- `npx markdownlint-cli2 packages/server/src/voice/stt/README.md docs/plans/lanes/V1-d.handoff.md`
  -> 0 errors.
- `npx eslint packages/server/src/voice/stt/*.ts packages/server/test/voice/stt/*.ts` -> 0.
  No `npm test`, browser gate, real model or network beyond loopback; lane envelope only.

## Judgement calls

- The exact base `SttResult` stays backend-neutral. `SttTranscription` adds the applied
  `biasing` and `origin`; the adapter implements `TranscribingSttAdapter`.
- `maxPromptChars` is an optional capability extension. 448 characters is an **unverified
  two-characters-per-token approximation** of the documented 224-token whisper limit. It is an
  adapter option, not a hidden UI cap; an over-budget term is dropped whole. A real tokenizer is
  still an open question below.
- Segment confidence is `clamp(exp(avg_logprob) * (1 - no_speech_prob))`. A single reported
  factor is used alone; neither reported factor means `null`, never a default.
- The whisper adapter is loopback-only, so production is local. The cloud/no-consent
  fake-server test passes a cloud policy input to exercise D-157 end to end.
- Result `language` is a normalized code through a small fixed map; an unknown full name is
  `null`, never a guess. The model label is caller-supplied because the server exposes no model
  id. Segment texts stay raw; every `origin` offset refers to final `text`.
  `glossaryRevision` is `glossaryRevisionHash` with stored revisions, otherwise a SHA-256
  content hash so plain V1-a entries still produce a stable marker.

## Verification

- Independent read-only review (two passes): one blocking timeout-range finding and several
  test/doc gaps; all fixed here. Reviewers made no edits; the final commands above are green.
- Independent V1-d review-fix round: P2 deadline and P3.1-P3.4 findings fixed in separate
  commits (see Independent review fixes). The final commands above are green.

## Open questions

- Real tokenizer: `WHISPER_SERVER_MAX_PROMPT_CHARS = 448` assumes two characters per token.
  Whisper's tokenizer is model-specific and `whisper-server` does not expose it, so whether 448
  characters stays under the 224-token initial-prompt limit for mixed Russian/Latin names is
  unverified. Keep 448 as the adapter's documented limit until a real tokenizer is available.

## Residuals

- On-device WhisperKit/SpeechAnalyzer and cloud STT adapters as K3 connections are absent;
  faster-whisper hotwords, vendor keyterms, a real tokenizer and real-model evidence are absent.
- No route, plugin service, contract type, composer control or editor UI; no real model,
  owner recordings, A/B measurement or V1 exit-gate evidence.
- The parent `voice/README.md` still calls STT adapters later work; the integrator should link V1-d.

## Independent review fixes

The independent review found the following defects; each is fixed on `codex/v1d-stt-adapter` in
its own commit with a regression test.

- **P2 — the 10-minute deadline was really ~300 s.** The adapter used global `fetch`, whose
  hidden 300 s response-header timeout fired before `transcribeTimeoutMs = 10 * 60_000`; the
  error mapped to `stt_unavailable`. The transport is now a `node:http` request with one
  adapter-owned deadline covering headers and body, so `transcribeTimeoutMs` is exact and a
  transport timeout maps to `stt_timeout`. Tests: a 300 ms deadline against headers delayed 1 s
  rejects as `stt_timeout` near 300 ms; 1 s headers succeed under a 2 s deadline; a global
  `fetch` stub that throws the old `UND_ERR_HEADERS_TIMEOUT` no longer affects the call.
- **P3.1 — the prompt budget read as measured.** 448 characters is now documented as an
  unverified two-characters-per-token approximation and as an open question above; it remains
  the adapter's documented limit.
- **P3.2 — HTTP 400 from `/inference` mapped to `stt_protocol`.** It now maps to
  `stt_audio_invalid`; the response body is still never echoed.
- **P3.3 — language was unvalidated and returned as a full name.** Requests accept only
  `/^[a-z]{2,3}(-[A-Za-z0-9]{2,8})*$/`; known whisper full names map to codes through a small
  fixed vocabulary, unknown names return `null`, and the result and origin carry the same code.
- **P3.4 — no caller-side audio-size expectation.** The README now states that there is no
  hidden byte cap, the adapter copies the buffer once into the multipart body, and the caller
  owns the recording-size policy.

Evidence after the fixes: 283 tests pass (71 V1-d: 27 biasing + 44 adapter), `tsc` 0, ESLint 0,
markdownlint 0.
