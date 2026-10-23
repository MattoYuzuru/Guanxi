# V1-d handoff — STT adapter contract and whisper.cpp server adapter

**Status:** implemented, locally validated on `codex/v1d-stt-adapter` against an in-process
loopback fake server. V1 remains in progress; no real model or recordings, so its exit gate is not measurable.

## What exists

- `types.ts`: `SttCapabilities`, `SttRequest`, `SttResult`, `SttAdapter`,
  `TranscribingSttAdapter`, `SttTranscription` (biasing + `VoiceOrigin`), `SttConnection`, `SttError`.
- `whisper-server.ts`: loopback-only whisper.cpp adapter using the shared `loopbackOrigin`
  check. Multipart `POST /inference` (`file`, `response_format=verbose_json`, `language`,
  optional `prompt`), `GET /health`, strict verbose_json parsing, a documented 224-token /
  448-character prompt budget, confidence only from `avg_logprob`/`no_speech_prob`, V1-a
  replacement and a validated V1-b origin. No redirects, retries or logging; the 16 MiB
  response cap and 10-minute deadline are transport budgets, not audio limits.
- `biasing.ts`: `glossaryAllowed` (D-157), `planBiasing` (canonical terms, deterministic
  folded-key order, whole-term budget, `withheld_no_consent`), `orderedPromptTerms`, `glossaryFingerprint`.
- `packages/server/src/voice/stt/README.md`: API assumptions in one place, evidence, confidence
  formula, D-157 and origin mapping, commands and residuals. `packages/server/test/voice/stt/`
  holds the in-process fake server plus 27 biasing and 38 adapter tests; the tests assert the
  exact form fields, including the absent `prompt` field.

## Commands and evidence

- `nice -n 10 node --test packages/server/test/voice/stt/*.test.ts packages/server/test/voice/*.test.ts`
  -> tests 277, pass 277, fail 0. New: 65 (27 biasing + 38 adapter); existing V1-a/b/c: 212.
- `nice -n 10 npx tsc --noEmit -p packages/server` -> exit 0, no diagnostics.
- `npx markdownlint-cli2 packages/server/src/voice/stt/README.md docs/plans/lanes/V1-d.handoff.md`
  -> 0 errors.
- `npx eslint packages/server/src/voice/stt/*.ts packages/server/test/voice/stt/*.ts` -> 0.
  No `npm test`, browser gate, real model or network beyond loopback; lane envelope only.

## Judgement calls

- The exact base `SttResult` stays backend-neutral. `SttTranscription` adds the applied
  `biasing` and `origin`; the adapter implements `TranscribingSttAdapter`.
- `maxPromptChars` is an optional capability extension. 448 characters is the documented
  224-token whisper limit at a conservative two characters per token. It is an adapter option,
  not a hidden UI cap; an over-budget term is dropped whole.
- Segment confidence is `clamp(exp(avg_logprob) * (1 - no_speech_prob))`. A single reported
  factor is used alone; neither reported factor means `null`, never a default.
- The whisper adapter is loopback-only, so production is local. The cloud/no-consent
  fake-server test passes a cloud policy input to exercise D-157 end to end.
- Result `language` is the server's full name; the model label is caller-supplied because the
  server exposes no model id. Segment texts stay raw; every `origin` offset refers to final
  `text`. `glossaryRevision` is `glossaryRevisionHash` with stored revisions, otherwise a
  SHA-256 content hash so plain V1-a entries still produce a stable marker.

## Verification

- Independent read-only review (two passes): one blocking timeout-range finding and several
  test/doc gaps; all fixed here. Reviewers made no edits; the final commands above are green.

## Residuals

- On-device WhisperKit/SpeechAnalyzer and cloud STT adapters as K3 connections are absent;
  faster-whisper hotwords, vendor keyterms, a real tokenizer and real-model evidence are absent.
- No route, plugin service, contract type, composer control or editor UI; no real model,
  owner recordings, A/B measurement or V1 exit-gate evidence.
- The parent `voice/README.md` still calls STT adapters later work; the integrator should link V1-d.
