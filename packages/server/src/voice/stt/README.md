# Speech-to-text adapters (V1-d)

**Status:** implemented adapter library (V1-d), validated against an in-process fake server;
not wired into the application · **Context updated:** 2026-11-01 · **Scope:**
the STT adapter contract, a loopback whisper.cpp `whisper-server` adapter, glossary biasing with
D-157 consent, deterministic post-ASR replacement and a voice-origin marker. No real model was
loaded and no network beyond loopback was used.

The contract is in `types.ts`, the planner in `biasing.ts`, and the adapter in
`whisper-server.ts`. This slice does not add a route, plugin wiring or UI, and it does not create
the owner's evaluation recordings; the V1 exit gate is still not measurable here.

The [voice plugin](../plugin.ts) currently provides only the glossary store/service, and the
application mounts only [glossary routes](../routes.ts). No production caller constructs
`WhisperServerAdapter`; the composer has no recording/transcription flow. The glossary editor
is implemented separately at `/settings/voice/glossary` and does not transcribe audio. Desktop
microphone permission and agent-facing delivery of the voice-origin marker also remain work.

## Contract

`types.ts` exports:

- `SttCapabilities`: adapter id, biasing mechanism, languages, streaming, diarization,
  `maxDurationSec`, `audioLeavesHost`, `source`, `observedAt` and `confidence`. The optional
  `maxPromptChars` extension is the adapter's own prompt budget; it is absent for adapters that
  do not bias by prompt.
- `SttRequest`: `audio` bytes, one of `audio/wav`, `audio/ogg`, `audio/mpeg` or `audio/webm`,
  an optional language and an optional effective glossary. A glossary entry may carry a stored
  `revision`, so entries from `GlossaryService.effective` can be passed through unchanged.
- `SttResult`: transcript `text`, `language`, `segments` with audio-second `start`/`end` and a
  `confidence` or `null`, `durationSec` and `source`.
- `SttAdapter` with `capabilities(signal?)` and `transcribe(req, signal?)`.
- `SttTranscription extends SttResult`: the concrete result of an adapter that always applies
  the glossary, adding the applied `biasing` and the V1-b `VoiceOrigin`.
- `TranscribingSttAdapter`: an `SttAdapter` whose `transcribe` returns `SttTranscription`.
- `SttError` with codes `stt_unavailable`, `stt_protocol`, `stt_audio_invalid` and
  `stt_timeout`. Its message is the code itself.

`SttResult` stays backend-neutral for future adapters. The whisper adapter implements
`TranscribingSttAdapter`, so callers that need the applied biasing and origin type it as that
interface (or as the concrete class).

## Caller-side audio size

The adapter imposes no audio byte cap and does not enforce an audio-duration limit
(`maxDurationSec` is `null`). It copies the supplied `Uint8Array` once into the multipart request
body, so during one call the caller's buffer and the adapter's copy coexist; peak memory is
roughly twice the audio payload plus multipart and JSON overhead. Callers choose their own
recording-length or file-size policy and keep the buffer alive for the duration of the call.

## whisper.cpp server assumptions

The adapter targets the Tier-1 `whisper-server` runtime from ADR-0031 and keeps every wire name
in `WHISPER_SERVER_API`:

| Item | Value |
| --- | --- |
| Health | `GET /health`; HTTP 200 `{"status":"ok"}`, HTTP 503 `{"status":"loading model"}` |
| Inference | `POST /inference`, multipart/form-data |
| File field | `file`, with a MIME-derived filename (`audio.wav`, `audio.ogg`, `audio.mp3`, `audio.webm`) |
| Response format | `response_format=verbose_json` |
| Language | `language=<request code>` or `language=auto` when the request omits it |
| Prompt | `prompt=<bounded canonical terms>` only when biasing is allowed and at least one term fits |

The adapter sends no `temperature`, `carry_initial_prompt`, `diarize` or other optional fields.
The server's documented defaults therefore apply. In particular, `prompt` is the server's
`initial_prompt`; the adapter does not set `carry_initial_prompt`, so the prompt conditions the
first window as the server defines it. `whisper-server` reads WAV directly; OGG, MPEG and WebM
input needs the server's `--convert` (ffmpeg) option. The adapter passes the bytes and filename
and does not transcode.

`verbose_json` is parsed for `text`, `language` (the server reports a full name such as
`russian`; a small fixed vocabulary maps known names to codes and an unknown name becomes
`null`, never a guessed code), `duration` and `segments[].start`/`end` (audio seconds), `text`,
`avg_logprob`/`no_speech_prob` when present. The server exposes no model id and no streaming
endpoint, so the caller supplies the model label (`unknown` by default) and the adapter declares
those facts `unknown`/false/null rather than guessing. Stereo diarization exists as a server
option but this adapter neither requests nor projects speaker labels, so its own `diarization`
capability is false. The adapter assumes the default `/health` and `/inference` paths; a server
started with `--request-path` or `--inference-path` is out of scope because the loopback check
admits no path in the base URL.

Sources: the [whisper.cpp server README](https://github.com/ggml-org/whisper.cpp/tree/61e6ccade0849f0f518c6decd1f25b3f9fb77b76/examples/server)
and [server.cpp](https://github.com/ggml-org/whisper.cpp/blob/61e6ccade0849f0f518c6decd1f25b3f9fb77b76/examples/server/server.cpp)
(pinned commit, observed 2026-10-23); [ADR-0031](../../../../../docs/decisions/0031-compute-fabric-node-agent-and-runtimes.md).

## Loopback admission

`baseUrl` goes through the repository's single llama-server `loopbackOrigin` check. It must be a
bare `http:` origin with an explicit port on `127.0.0.1`, `localhost` or `[::1]`; credentials,
paths, queries, fragments, HTTPS, `0.0.0.0` and remote hosts are refused with
`stt_unavailable` before any request. The adapter follows no redirect and sends no credential.
Its `audioLeavesHost` capability is therefore `false`. The shared helper treats `localhost` as a
loopback name; an OS hosts-file or resolver override of that name is outside this adapter's
boundary.

## Capabilities and the prompt budget

`capabilities()` probes `/health` and returns:

| Field | Value | Why |
| --- | --- | --- |
| `adapter` | `whisper.cpp-server` | This adapter |
| `biasing` | `initial_prompt` | The server's multipart `prompt` |
| `languages` | `unknown` | The loaded model and its languages are not exposed |
| `streaming` | `false` | `/inference` is request/response |
| `diarization` | `false` | The adapter does not request or project speakers |
| `maxDurationSec` | `null` | The adapter imposes no duration limit |
| `audioLeavesHost` | `false` | Loopback admission |
| `source` | the whisper.cpp server tree URL | One stable citation point |
| `observedAt` | the successful health-probe time | Observation time |
| `confidence` | `documented` | The facts come from the server source; the probe proves availability |
| `maxPromptChars` | 448 by default | Adapter-owned character budget (unverified 2 chars/token) |

The whisper default is 224 prompt tokens. The adapter uses **two characters per token as an
unverified approximation**, not a tokenizer measurement; real tokenization is model-specific and
the server does not expose it. That gives `WHISPER_SERVER_MAX_PROMPT_CHARS = 448`, which stays the
adapter's documented limit. Whether 448 characters is safely below 224 tokens for mixed
Russian/Latin name lists is an **open question** until a real tokenizer exists; the value is a
character budget, not a claimed token count. `maxPromptChars` is a constructor option and is
reported by `capabilities()`; there is no hidden constant in the planner or UI. It can be lowered
for a smaller window, and the adapter never splits a term.

## Biasing and D-157

`glossaryAllowed(connection)` implements D-157: a local connection may use the glossary; a cloud
connection may use it only with an explicit `glossaryConsent: true`. A malformed connection
throws `TypeError` rather than defaulting to consent.

`planBiasing()` maps the effective glossary to the declared mechanism:

1. an empty glossary is `none`;
2. an adapter whose `biasing` is `none` gets `none`;
3. a cloud connection without consent gets `withheld_no_consent`, no prompt and no sent terms;
4. otherwise canonical terms are sorted by folded key, then exact canonical, then id. Duplicate
   folded keys keep the first sorted form. `initial_prompt` joins terms with a comma and a space; `hotwords`
   and `keyterms` use one term per line for adapters that own those wire formats.
5. terms are added whole while the prompt stays within the adapter's `maxPromptChars`,
   measured in Unicode code points. `included` and `omitted` report the fit; a term that does
   not fit is dropped, never cut.

Only canonicals are sent, not spoken variants. A Latin canonical stays Latin when the speech
language is Cyrillic; it is the spelling the glossary owns and the replacement layer wants.
The planner does not transliterate canonicals. The transcript result reports what actually
happened in `biasing` (`initial_prompt`, `none` or `withheld_no_consent`), so a withheld request
is distinguishable from a request with nothing to send. D-157 withholds the *prompt field*, not
the local deterministic replacement: replacement still runs after transcription.

## Replacement and voice origin

After a successful inference the adapter compiles the request glossary with the V1-a compiler
and always applies it, even when biasing was withheld. `text` is the post-replacement
transcript. Replacements are remapped from raw-transcript offsets to final-text offsets, and
each final slice is checked against its replacement before a `VoiceOrigin` is built. Segment
texts remain the backend's raw output; every offset in `origin` refers to the final `text`, not
to a segment string.

Confidence spans come from segments that reported a confidence and whose `text` occurs
sequentially in the raw transcript. The raw span is mapped through the same replacements, then
sorted, clamped and made non-overlapping. A segment with `confidence: null` contributes no span;
a segment whose text cannot be located contributes no span but remains in `segments`. This keeps
the marker valid without inventing an offset. The origin is passed through
`validateVoiceOrigin` against the final text; a validation failure is `stt_protocol`.

`glossaryRevision` is `glossaryRevisionHash` over `{id, revision}` when every supplied entry
carries a stored positive revision. For plain V1-a entries it is SHA-256 over a canonical
content projection (ids, canonicals, sorted variants, language and flags), so the marker is
still stable across input order and variant order. The two forms are deliberately not mixed: a
partially revised set gets the content hash.

Segment confidence is derived only from backend-reported values:

```text
confidence = clamp(exp(avg_logprob) * (1 - no_speech_prob), 0, 1)
```

If only one of the two fields is present, that factor is used alone and the missing factor is
neutral (1) in the product; it is not estimated from the other signal. If neither is present the
confidence is `null`. `no_speech_prob` is validated in `[0, 1]`. The adapter never invents a
numeric confidence when the backend reported neither signal.

## Errors and privacy

- `stt_audio_invalid`: empty or non-`Uint8Array` audio, an unsupported MIME type, or HTTP 400
  from `/inference` (whisper-server could not decode the supplied bytes).
- `stt_protocol`: malformed request glossary/language, malformed or non-JSON verbose_json,
  missing or invalid fields, an oversized answer, or any other unexpected non-200 answer.
- `stt_unavailable`: non-loopback configuration, an unreachable server, HTTP 503 (model
  loading), or a redirect (never followed).
- `stt_timeout`: the adapter-owned deadline or a caller abort. The deadline covers response
  headers and body; a pre-aborted call sends nothing.

Every thrown adapter error is a `SttError` whose message is the code. Glossary compiler errors
can quote terms, and response bodies can quote transcripts; both are caught and replaced with
the code. Audio bytes, transcript text, glossary terms and response bodies are never logged,
never placed in an error and never sent outside the loopback origin unless the caller's own
`baseUrl` passed loopback admission. The transport follows no redirect, caps one JSON answer
(`16 MiB` by default, a transport budget) and enforces the inference call's
`transcribeTimeoutMs` (ten minutes by default) itself with a `node:http` request. There is no
hidden transport cap: the previous global-fetch transport gave up at 300 s while waiting for
headers and reported `stt_unavailable`, before the ten-minute deadline. Timeout options are
bounded to Node's signed 32-bit timer range so they cannot escape the typed-error contract. Those
are operational budgets, not audio-duration limits; `maxDurationSec` remains `null`.

## Tests and commands

`packages/server/test/voice/stt/` contains an in-process fake server and two test files:

- `biasing.test.ts`: 27 tests for D-157, deterministic ordering, canonical-only prompts,
  Cyrillic-speech script preservation, the bounded budget, omitted terms, other mechanisms and
  glossary fingerprints.
- `whisper-server.test.ts`: 44 tests for loopback admission, capabilities, exact multipart
  fields, verbose_json parsing, confidence nulls, replacement/origin mapping, revisions,
  D-157 withholding (the tests assert the `prompt` field is absent), redirects, chunked/truncated
  answers, retry/logging, protocol, HTTP 400, language codes and normalization, the exact
  transport deadline, availability, timeout/abort, audio validation and content-free errors.

```bash
nice -n 10 node --test packages/server/test/voice/stt/*.test.ts packages/server/test/voice/*.test.ts
nice -n 10 npx tsc --noEmit -p packages/server
npx markdownlint-cli2 packages/server/src/voice/stt/README.md docs/plans/lanes/V1-d.handoff.md
```

The fake server is only a protocol fixture. It does not prove transcription quality, a real
model's tokenization, or the V1 gate.

## Limits and residuals

- No on-device WhisperKit/SpeechAnalyzer adapter and no cloud STT adapter as a K3 connection.
- No faster-whisper `hotwords` adapter, no vendor keyterm adapter and no real tokenizer.
- No STT REST route, registered adapter service, transcription wire contract or composer
  control. The separate glossary plugin, REST contract and editor are implemented.
- The model label is caller-supplied because `whisper-server` exposes no model id; the default
  is `unknown`, and the voice block can only repeat that.
- Returned `language` uses a small fixed vocabulary (`english` -> `en`, `russian` -> `ru`); a
  supported whisper language outside that map returns `null` until the map grows.
- The prompt is a bounded canonical list, not the natural-sentence style recommended by the
  research; `carry_initial_prompt` is not sent, so prompt coverage follows server semantics.
- No real model, no owner's eval recordings, no A/B measurement, no on-device latency or memory
  evidence. The V1 exit gate remains blocked on the owner's recordings and a real evaluation.
- Response-size and timeout values are transport budgets; changing them does not change
  `maxDurationSec`.
