/**
 * Backend-neutral speech-to-text (STT) adapter contract (V1-d).
 *
 * The contract describes what an adapter can do before it is used, one transcription request,
 * one result, and the typed errors callers may handle. It carries no audio, no credentials and
 * no network code.
 */

import type { GlossaryEntry } from '../glossary.ts'
import type { VoiceOrigin } from '../marker.ts'

export type SttMimeType = 'audio/wav' | 'audio/ogg' | 'audio/mpeg' | 'audio/webm'

/** What a backend can do, with provenance. `observedAt` is when the adapter probed it. */
export interface SttCapabilities {
  adapter: string
  biasing: 'initial_prompt' | 'hotwords' | 'keyterms' | 'none'
  /** ISO 639-1 codes, a richer list, or `unknown` when the backend does not expose the model. */
  languages: string[] | 'unknown'
  streaming: boolean
  diarization: boolean
  /** Adapter-imposed maximum audio duration, or null when the adapter imposes none. */
  maxDurationSec: number | null
  /** True only when audio crosses the host boundary. Loopback adapters keep it false. */
  audioLeavesHost: boolean
  source: string
  observedAt: string
  confidence: 'observed' | 'documented'
  /**
   * Character budget for this adapter's prompt biasing, when it has one. The adapter owns the
   * value; it is not a UI ceiling. Absent for adapters that do not bias by prompt.
   */
  maxPromptChars?: number
}

/**
 * A glossary entry supplied to an adapter. `revision` is optional so plain V1-a entries work;
 * entries from `GlossaryService.effective` carry it and then produce the same revision hash as
 * the voice marker.
 */
export interface SttGlossaryEntry extends GlossaryEntry {
  revision?: number
}

export interface SttRequest {
  audio: Uint8Array
  mimeType: SttMimeType
  /** Spoken language code; the adapter sends `auto` when it is omitted. */
  language?: string
  /** Effective glossary for biasing and deterministic post-ASR replacement. */
  glossary?: SttGlossaryEntry[]
}

/** One backend segment. `start` and `end` are audio seconds, not string offsets. */
export interface SttSegment {
  start: number
  end: number
  text: string
  /** Derived only from backend-reported values; null means the backend reported none. */
  confidence: number | null
}

export interface SttResult {
  text: string
  language: string | null
  segments: SttSegment[]
  durationSec: number | null
  source: string
}

/** What the adapter actually did with the glossary: a mechanism, none, or D-157 withholding. */
export type SttBiasingOutcome =
  | 'initial_prompt'
  | 'hotwords'
  | 'keyterms'
  | 'none'
  | 'withheld_no_consent'

/**
 * Concrete result for adapters that run deterministic replacement. The base `SttResult` stays
 * backend-neutral; this extension exposes the applied biasing and the voice-origin marker.
 */
export interface SttTranscription extends SttResult {
  biasing: SttBiasingOutcome
  origin: VoiceOrigin
}

export interface SttAdapter {
  capabilities(signal?: AbortSignal): Promise<SttCapabilities>
  transcribe(req: SttRequest, signal?: AbortSignal): Promise<SttResult>
}

/** An STT adapter that always applies the glossary and returns a voice origin. */
export interface TranscribingSttAdapter extends SttAdapter {
  transcribe(req: SttRequest, signal?: AbortSignal): Promise<SttTranscription>
}

export type SttConnectionKind = 'local' | 'cloud'

/**
 * Privacy class of the connection a caller selected. D-157 allows glossary biasing for a local
 * connection, or for a cloud connection only after explicit per-connection consent.
 */
export interface SttConnection {
  kind: SttConnectionKind
  glossaryConsent: boolean
}

export type SttErrorCode =
  | 'stt_unavailable'
  | 'stt_protocol'
  | 'stt_audio_invalid'
  | 'stt_timeout'

/**
 * Content-free adapter failure. The message is the code itself: audio bytes, transcript text,
 * glossary terms and server error bodies never reach a thrown error or a log.
 */
export class SttError extends Error {
  readonly code: SttErrorCode

  constructor(code: SttErrorCode) {
    super(code)
    this.name = 'SttError'
    this.code = code
  }
}
