# ADR-0028: Voice input, per-project glossary and learning from corrections

**Status:** proposed · **Date:** 2026-10-19

## Context

Dictation is a primary input (the owner dictates long prompts). Product names, terms and
mixed Russian/English words are misrecognised, and agents then spend tokens guessing, which
can mislead small local models. The brief asks for selectable STT backends (on-device, a
whisper.cpp node, a VPS, a paid API), a per-project glossary with automatic replacement,
voice-origin markers and audits that learn glossary entries (REQ-I1, REQ-I2).

Lane 5: each backend biases differently (Whisper `initial_prompt`, faster-whisper `hotwords`,
NeMo/Parakeet word boosting, vendor keyterm prompting); plain prompt biasing raised unbiased
WER on all 11 datasets in one study, so biasing trades B-WER against U-WER; no open-source
dictionary checked handles Cyrillic transliterations of English terms ("хоно" → Hono).

## Decision

1. **STT backend adapters** with capability evidence: biasing method, languages, streaming,
   diarization, max duration, where audio goes. Backends: on-device (WhisperKit / Apple
   SpeechAnalyzer on Apple platforms, whisper.cpp elsewhere), whisper.cpp or faster-whisper on
   a node, cloud APIs as connections.
2. **Glossary** per project (and per account): canonical term, spoken variants, transliteration
   keys, language, case rules, inflection notes. Each backend adapter maps it to its own
   biasing mechanism within that backend's limits.
3. **Deterministic post-ASR replacement always runs**, with transliteration-aware matching;
   optional LLM correction (generative error correction) is a separate job limited to glossary
   terms that shows a diff and never sends the message itself.
4. **Voice-origin marker**: prompts carry `origin: voice`, backend, model and confidence spans;
   agents receive a short voice block and a `voice.flag_term` tool that only proposes glossary
   candidates.
5. **Learning loop** (risk class RC0 in ADR-0024): candidates come from (a) the user editing
   the transcript before sending, (b) the agent's inferred intended word, (c) a later user
   correction. A candidate is applied automatically only after its pre-apply gate passes on
   the eval set (term F1 does not drop, U-WER rises by at most 1 point); otherwise it waits in
   the user's review queue. Every applied entry has one-click revert.
6. **Measurement**: B-WER, U-WER and term F1 on 100–150 of the owner's own recordings (about
   20 minutes), re-run when the glossary or backend changes.
7. **Privacy**: audio retention is a per-account setting, 7 days by default; sending the
   glossary to a cloud STT vendor requires per-connection consent and is off by default
   (D-157). Inflected English terms in Russian speech are written as the Latin-script term with
   the Russian ending after a hyphen (`PR-а`); V1 may revise this from the eval set.

## Validation

Golden tests for transliteration matching; a regression set where the glossary must fix
planted misrecognitions without increasing U-WER beyond a threshold.

## Evidence

Lane 5 §2 ([research](../research/README.md)).
