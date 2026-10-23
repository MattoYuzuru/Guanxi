/**
 * whisper.cpp `whisper-server` STT adapter (ADR-0031 Tier 1, ADR-0028 decision 1).
 *
 * The adapter talks to one loopback origin, sends one multipart `/inference` request in
 * `verbose_json` form, runs the V1-a deterministic glossary replacement over the transcript and
 * returns a V1-b voice origin. It retries nothing, follows no redirect, carries no credential,
 * and never logs or throws audio, transcript text or glossary terms.
 *
 * Backend assumptions are kept in {@link WHISPER_SERVER_API} and in the STT README:
 * - `GET /health` answers `{"status":"ok"}`, or HTTP 503 while the model loads;
 * - `POST /inference` takes multipart `file`, `response_format=verbose_json`, `language` and an
 *   optional `prompt`;
 * - `verbose_json` has `text`, `language` (a full name such as `russian`; the adapter maps a
 *   small fixed vocabulary to an ISO code and returns null for an unknown name), `duration` and
 *   `segments[]` with `start`/`end` in audio seconds, `text`, `avg_logprob` and
 *   `no_speech_prob` when the server reports them;
 * - the server exposes no model id and no streaming endpoint, so the caller supplies the model
 *   label and the adapter declares those capabilities `unknown`/false/null rather than guessing.
 *
 * The 224-token initial-prompt limit is the documented whisper default. The adapter exposes a
 * conservative character proxy (two characters per token) so Cyrillic and name lists are not
 * over-filled; the value is an adapter limit, never a hidden UI or policy cap.
 */

import { randomUUID } from 'node:crypto'
import { request as httpRequest, type IncomingMessage } from 'node:http'
import { z } from 'zod'
import {
  applyGlossary,
  compileGlossary,
  type CompiledGlossary,
  type Replacement,
  type ReplaceResult,
} from '../glossary.ts'
import {
  validateVoiceOrigin,
  type VoiceConfidenceSpan,
  type VoiceOrigin,
  type VoiceReplacement,
} from '../marker.ts'
import { loopbackOrigin } from '../../runtime/llama-server/client.ts'
import { glossaryAllowed, glossaryFingerprint, planBiasing } from './biasing.ts'
import {
  SttError,
  type SttCapabilities,
  type SttConnection,
  type SttMimeType,
  type SttRequest,
  type SttSegment,
  type SttTranscription,
  type TranscribingSttAdapter,
} from './types.ts'

export const WHISPER_SERVER_ADAPTER = 'whisper.cpp-server'
export const WHISPER_SERVER_BACKEND = 'whisper.cpp'
export const WHISPER_SERVER_SOURCE =
  'https://github.com/ggml-org/whisper.cpp/tree/61e6ccade0849f0f518c6decd1f25b3f9fb77b76/examples/server'
export const WHISPER_SERVER_RESULT_SOURCE = 'whisper.cpp-server:/inference verbose_json'
export const WHISPER_SERVER_PROMPT_TOKEN_LIMIT = 224
/**
 * Two characters per token: a conservative proxy for a mixed Russian/Latin name list. The real
 * tokenizer is model-specific and is not exposed by the server; the README states this.
 */
export const WHISPER_SERVER_MAX_PROMPT_CHARS = WHISPER_SERVER_PROMPT_TOKEN_LIMIT * 2
export const WHISPER_SERVER_MAX_JSON_BYTES = 16 * 1024 * 1024
export const WHISPER_SERVER_REQUEST_TIMEOUT_MS = 15_000
/**
 * One `/inference` call. The adapter's own deadline is authoritative: the previous transport
 * used global fetch, whose hidden 300 s response-header timeout fired first and surfaced as
 * `stt_unavailable`; this transport has no such cap.
 */
export const WHISPER_SERVER_TRANSCRIBE_TIMEOUT_MS = 10 * 60_000
/** Node's timers accept at most a signed 32-bit millisecond delay. */
export const WHISPER_SERVER_MAX_TIMEOUT_MS = 2_147_483_647

/** Short BCP-47/ISO 639-1 shape accepted for a requested language. */
const LANGUAGE_PATTERN = /^[a-z]{2,3}(-[A-Za-z0-9]{2,8})*$/

/**
 * whisper.cpp reports a full language name in `verbose_json`. This fixed vocabulary is the
 * adapter's whole mapping; an unknown name returns null rather than a guessed code.
 */
const LANGUAGE_CODES: Readonly<Record<string, string>> = Object.freeze({
  arabic: 'ar',
  armenian: 'hy',
  azerbaijani: 'az',
  belarusian: 'be',
  czech: 'cs',
  danish: 'da',
  dutch: 'nl',
  english: 'en',
  finnish: 'fi',
  french: 'fr',
  georgian: 'ka',
  german: 'de',
  greek: 'el',
  hebrew: 'he',
  hindi: 'hi',
  hungarian: 'hu',
  indonesian: 'id',
  italian: 'it',
  japanese: 'ja',
  kazakh: 'kk',
  korean: 'ko',
  malay: 'ms',
  norwegian: 'no',
  persian: 'fa',
  polish: 'pl',
  portuguese: 'pt',
  romanian: 'ro',
  russian: 'ru',
  spanish: 'es',
  swedish: 'sv',
  thai: 'th',
  turkish: 'tr',
  ukrainian: 'uk',
  uzbek: 'uz',
  vietnamese: 'vi',
  chinese: 'zh',
})

function normalizeLanguage(value: string | null | undefined): string | null {
  if (typeof value !== 'string') return null
  const normalized = value.trim().toLowerCase()
  if (normalized.length === 0) return null
  const mapped = LANGUAGE_CODES[normalized]
  if (mapped !== undefined) return mapped
  // The documented output is a full name, but keep an already-short server code instead of
  // discarding a fact the server actually reported. Anything longer and unknown is null.
  return /^[a-z]{2,3}$/.test(normalized) ? normalized : null
}

/** The one place that names the whisper.cpp server wire fields this adapter sends or reads. */
export const WHISPER_SERVER_API = Object.freeze({
  healthPath: '/health',
  inferencePath: '/inference',
  fileField: 'file',
  responseFormatField: 'response_format',
  responseFormat: 'verbose_json',
  languageField: 'language',
  promptField: 'prompt',
  autoLanguage: 'auto',
  healthOk: 'ok',
})

const MIME_TYPES: ReadonlySet<string> = new Set(['audio/wav', 'audio/ogg', 'audio/mpeg', 'audio/webm'])
const FILENAMES: Readonly<Record<SttMimeType, string>> = Object.freeze({
  'audio/wav': 'audio.wav',
  'audio/ogg': 'audio.ogg',
  'audio/mpeg': 'audio.mp3',
  'audio/webm': 'audio.webm',
})

const segmentSchema = z.object({
  start: z.number().finite().nonnegative(),
  end: z.number().finite().nonnegative(),
  text: z.string(),
  avg_logprob: z.number().finite().nullish(),
  no_speech_prob: z.number().finite().min(0).max(1).nullish(),
}).passthrough().refine((segment) => segment.end >= segment.start, {
  message: 'segment end must not precede start',
})

const verboseJsonSchema = z.object({
  text: z.string(),
  language: z.string().min(1).nullish(),
  duration: z.number().finite().nonnegative().nullish(),
  segments: z.array(segmentSchema),
}).passthrough()

type ParsedSegment = z.infer<typeof segmentSchema>

export interface WhisperServerAdapterOptions {
  /** Bare loopback HTTP origin with an explicit port, for example `http://127.0.0.1:8080`. */
  baseUrl: string
  /** Model label recorded in the voice origin; the server does not expose one. Defaults to `unknown`. */
  model?: string
  /** Privacy class used by the D-157 glossary gate. Defaults to a local connection. */
  connection?: SttConnection
  /** Health and other short reads. */
  requestTimeoutMs?: number
  /** One `/inference` call. */
  transcribeTimeoutMs?: number
  /** Character proxy for the initial-prompt token limit. Defaults to the documented adapter value. */
  maxPromptChars?: number
  /** Upper bound for one JSON answer. A transport budget, not an audio-duration limit. */
  maxResponseBytes?: number
  /** Test seam for the capability observation time. */
  now?: () => Date
}

interface RawConfidenceSpan {
  start: number
  end: number
  confidence: number
}

interface JsonRequestInit {
  method: 'GET' | 'POST'
  /** Already-serialised request body; the transport copies nothing. */
  body?: Uint8Array
  contentType?: string
}

/** Serialise one multipart body, copying the audio bytes exactly once. */
function inferenceBody(
  req: SttRequest,
  prompt: string | undefined,
): { body: Buffer; contentType: string } {
  const boundary = `----guanxi-${randomUUID()}`
  const field = (name: string, value: string): Buffer => Buffer.from(
    `--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`,
    'utf8',
  )
  const parts: Uint8Array[] = [
    Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="${WHISPER_SERVER_API.fileField}"; filename="${FILENAMES[req.mimeType]}"\r\nContent-Type: ${req.mimeType}\r\n\r\n`,
      'utf8',
    ),
    req.audio,
    Buffer.from('\r\n', 'utf8'),
    field(WHISPER_SERVER_API.responseFormatField, WHISPER_SERVER_API.responseFormat),
    field(
      WHISPER_SERVER_API.languageField,
      req.language === undefined ? WHISPER_SERVER_API.autoLanguage : req.language,
    ),
  ]
  if (prompt !== undefined) parts.push(field(WHISPER_SERVER_API.promptField, prompt))
  parts.push(Buffer.from(`--${boundary}--\r\n`, 'utf8'))
  return {
    body: Buffer.concat(parts),
    contentType: `multipart/form-data; boundary=${boundary}`,
  }
}

function segmentConfidence(segment: ParsedSegment): number | null {
  const hasLogprob = typeof segment.avg_logprob === 'number'
  const hasNoSpeech = typeof segment.no_speech_prob === 'number'
  if (!hasLogprob && !hasNoSpeech) return null
  // Geometric mean token probability (exp of the mean log-probability) times the probability
  // that the segment contains speech. The token factor is clamped before multiplication so a
  // huge finite log-probability cannot overflow into Infinity * 0 = NaN. A missing factor is
  // neutral (1) in the product; it is not estimated from the other signal.
  const tokenProbability = hasLogprob
    ? Math.min(1, Math.exp(segment.avg_logprob as number))
    : 1
  const speechProbability = hasNoSpeech ? 1 - (segment.no_speech_prob as number) : 1
  return Math.min(1, Math.max(0, tokenProbability * speechProbability))
}

function rawConfidenceSpans(text: string, segments: readonly SttSegment[]): RawConfidenceSpan[] {
  const spans: RawConfidenceSpan[] = []
  let cursor = 0
  for (const segment of segments) {
    if (segment.text.length === 0) continue
    const start = text.indexOf(segment.text, cursor)
    if (start < 0) continue
    const end = start + segment.text.length
    cursor = end
    if (segment.confidence === null) continue
    spans.push({ start, end, confidence: segment.confidence })
  }
  return spans
}

function mapOffset(
  offset: number,
  edge: 'start' | 'end',
  replacements: readonly Replacement[],
): number {
  let delta = 0
  for (const replacement of replacements) {
    if (offset >= replacement.end) {
      delta += replacement.replacement.length - (replacement.end - replacement.start)
      continue
    }
    if (offset <= replacement.start) break
    return edge === 'start'
      ? replacement.start + delta
      : replacement.start + delta + replacement.replacement.length
  }
  return offset + delta
}

function finalConfidenceSpans(
  raw: readonly RawConfidenceSpan[],
  replacements: readonly Replacement[],
  finalLength: number,
): VoiceConfidenceSpan[] {
  const spans: VoiceConfidenceSpan[] = []
  let previousEnd = 0
  for (const span of raw) {
    const start = Math.max(previousEnd, mapOffset(span.start, 'start', replacements))
    const end = Math.min(finalLength, mapOffset(span.end, 'end', replacements))
    if (end <= start) continue
    spans.push({ start, end, confidence: span.confidence })
    previousEnd = end
  }
  return spans
}

function finalReplacements(
  replacements: readonly Replacement[],
  finalText: string,
): VoiceReplacement[] {
  let delta = 0
  return replacements.map((replacement) => {
    const start = replacement.start + delta
    const end = start + replacement.replacement.length
    if (finalText.slice(start, end) !== replacement.replacement) {
      throw new SttError('stt_protocol')
    }
    delta += replacement.replacement.length - (replacement.end - replacement.start)
    return {
      start,
      end,
      original: replacement.original,
      replacement: replacement.replacement,
      entryId: replacement.entryId,
    }
  })
}

function positiveInteger(value: number, field: string, max = Number.MAX_SAFE_INTEGER): number {
  if (!Number.isSafeInteger(value) || value <= 0 || value > max) {
    throw new TypeError(`Whisper server ${field} must be a positive integer no greater than ${max}`)
  }
  return value
}

export class WhisperServerAdapter implements TranscribingSttAdapter {
  readonly baseUrl: string
  readonly maxPromptChars: number
  private readonly model: string
  private readonly connection: SttConnection
  private readonly requestTimeoutMs: number
  private readonly transcribeTimeoutMs: number
  private readonly maxResponseBytes: number
  private readonly now: () => Date

  constructor(options: WhisperServerAdapterOptions) {
    if (options === null || typeof options !== 'object') {
      throw new TypeError('Whisper server options must be an object')
    }
    try {
      const origin = loopbackOrigin(options.baseUrl)
      // The shared helper accepts a syntactically explicit port; port 0 is not a server.
      if (new URL(origin).port === '0') throw new SttError('stt_unavailable')
      this.baseUrl = origin
    } catch {
      // The shared loopback admission helper is llama-server-specific; this adapter exposes
      // the same refusal as its own typed, content-free availability error.
      throw new SttError('stt_unavailable')
    }
    const model = options.model === undefined ? 'unknown' : options.model
    if (typeof model !== 'string' || model.trim().length === 0) {
      throw new TypeError('Whisper server model must be a non-empty string')
    }
    this.model = model.trim()
    if (options.connection !== undefined) glossaryAllowed(options.connection)
    this.connection = {
      kind: options.connection?.kind ?? 'local',
      glossaryConsent: options.connection?.glossaryConsent ?? false,
    }
    // Validate the D-157 policy input at construction, not on the first request.
    // `glossaryAllowed` throws a content-free TypeError for an invalid shape.
    glossaryAllowed(this.connection)

    this.requestTimeoutMs = positiveInteger(
      options.requestTimeoutMs === undefined
        ? WHISPER_SERVER_REQUEST_TIMEOUT_MS
        : options.requestTimeoutMs,
      'requestTimeoutMs',
      WHISPER_SERVER_MAX_TIMEOUT_MS,
    )
    this.transcribeTimeoutMs = positiveInteger(
      options.transcribeTimeoutMs === undefined
        ? WHISPER_SERVER_TRANSCRIBE_TIMEOUT_MS
        : options.transcribeTimeoutMs,
      'transcribeTimeoutMs',
      WHISPER_SERVER_MAX_TIMEOUT_MS,
    )
    this.maxPromptChars = positiveInteger(
      options.maxPromptChars === undefined
        ? WHISPER_SERVER_MAX_PROMPT_CHARS
        : options.maxPromptChars,
      'maxPromptChars',
    )
    this.maxResponseBytes = positiveInteger(
      options.maxResponseBytes === undefined
        ? WHISPER_SERVER_MAX_JSON_BYTES
        : options.maxResponseBytes,
      'maxResponseBytes',
    )
    this.now = options.now === undefined ? (() => new Date()) : options.now
    if (typeof this.now !== 'function') {
      throw new TypeError('Whisper server now must be a function')
    }
  }

  async capabilities(signal?: AbortSignal): Promise<SttCapabilities> {
    this.assertNotAborted(signal)
    await this.health(signal)
    return {
      adapter: WHISPER_SERVER_ADAPTER,
      biasing: 'initial_prompt',
      languages: 'unknown',
      streaming: false,
      diarization: false,
      maxDurationSec: null,
      audioLeavesHost: false,
      source: WHISPER_SERVER_SOURCE,
      observedAt: this.observedAt(),
      confidence: 'documented',
      maxPromptChars: this.maxPromptChars,
    }
  }

  async transcribe(req: SttRequest, signal?: AbortSignal): Promise<SttTranscription> {
    this.assertNotAborted(signal)
    this.validateRequest(req)
    const entries = req.glossary ?? []

    let compiled: CompiledGlossary
    try {
      compiled = compileGlossary(entries)
    } catch {
      throw new SttError('stt_protocol')
    }

    let plan
    try {
      plan = planBiasing({
        entries,
        capabilities: { biasing: 'initial_prompt', maxPromptChars: this.maxPromptChars },
        connection: this.connection,
        ...(req.language === undefined ? {} : { language: req.language }),
      })
    } catch {
      throw new SttError('stt_protocol')
    }

    let glossaryRevision: string
    try {
      glossaryRevision = glossaryFingerprint(entries)
    } catch {
      throw new SttError('stt_protocol')
    }

    const form = inferenceBody(req, plan.prompt)
    const { status, body } = await this.jsonRequest(
      WHISPER_SERVER_API.inferencePath,
      { method: 'POST', body: form.body, contentType: form.contentType },
      signal,
      this.transcribeTimeoutMs,
    )
    // node:http does not follow redirects; keep the old transport's refusal classification.
    if (status >= 300 && status < 400) throw new SttError('stt_unavailable')
    // whisper-server answers 400 when it cannot decode the supplied audio bytes.
    if (status === 400) throw new SttError('stt_audio_invalid')
    if (status === 503) throw new SttError('stt_unavailable')
    if (status !== 200) throw new SttError('stt_protocol')

    const parsed = verboseJsonSchema.safeParse(body)
    if (!parsed.success) throw new SttError('stt_protocol')
    const language = normalizeLanguage(parsed.data.language)
    const segments: SttSegment[] = parsed.data.segments.map((segment) => ({
      start: segment.start,
      end: segment.end,
      text: segment.text,
      confidence: segmentConfidence(segment),
    }))

    let replaced: ReplaceResult
    let replacements: VoiceReplacement[]
    let confidenceSpans: VoiceConfidenceSpan[]
    try {
      replaced = applyGlossary(compiled, parsed.data.text)
      replacements = finalReplacements(replaced.replacements, replaced.text)
      confidenceSpans = finalConfidenceSpans(
        rawConfidenceSpans(parsed.data.text, segments),
        replaced.replacements,
        replaced.text.length,
      )
    } catch (error) {
      if (error instanceof SttError) throw error
      throw new SttError('stt_protocol')
    }

    let origin: VoiceOrigin
    try {
      origin = validateVoiceOrigin({
        origin: 'voice',
        backend: WHISPER_SERVER_BACKEND,
        model: this.model,
        language,
        confidenceSpans,
        replacements,
        glossaryRevision,
      }, replaced.text)
    } catch {
      throw new SttError('stt_protocol')
    }

    return {
      text: replaced.text,
      language,
      segments,
      durationSec: parsed.data.duration ?? null,
      source: WHISPER_SERVER_RESULT_SOURCE,
      biasing: plan.outcome,
      origin,
    }
  }

  private validateRequest(req: SttRequest): void {
    if (req === null || typeof req !== 'object' || Array.isArray(req)) {
      throw new SttError('stt_audio_invalid')
    }
    if (!(req.audio instanceof Uint8Array) || req.audio.byteLength === 0) {
      throw new SttError('stt_audio_invalid')
    }
    if (typeof req.mimeType !== 'string' || !MIME_TYPES.has(req.mimeType)) {
      throw new SttError('stt_audio_invalid')
    }
    if (req.language !== undefined
      && (typeof req.language !== 'string' || !LANGUAGE_PATTERN.test(req.language))) {
      throw new SttError('stt_protocol')
    }
    if (req.glossary !== undefined && !Array.isArray(req.glossary)) {
      throw new SttError('stt_protocol')
    }
  }

  private async health(signal?: AbortSignal): Promise<void> {
    const { status, body } = await this.jsonRequest(
      WHISPER_SERVER_API.healthPath,
      { method: 'GET' },
      signal,
      this.requestTimeoutMs,
    )
    if (status >= 300 && status < 400) throw new SttError('stt_unavailable')
    if (status === 503) throw new SttError('stt_unavailable')
    if (status !== 200) throw new SttError('stt_protocol')
    if (body === null || typeof body !== 'object' || Array.isArray(body)
      || (body as { status?: unknown }).status !== WHISPER_SERVER_API.healthOk) {
      throw new SttError('stt_protocol')
    }
  }

  private async jsonRequest(
    path: string,
    init: JsonRequestInit,
    signal: AbortSignal | undefined,
    timeoutMs: number,
  ): Promise<{ status: number; body: unknown }> {
    this.assertNotAborted(signal)
    let request: ReturnType<typeof httpRequest>
    try {
      request = httpRequest(new URL(this.baseUrl + path), {
        method: init.method,
        // A one-shot agent keeps one call to one loopback origin independent of any pool.
        agent: false,
        headers: {
          accept: 'application/json',
          connection: 'close',
          ...(init.body === undefined ? {} : {
            'content-type': init.contentType ?? 'application/octet-stream',
            'content-length': String(init.body.byteLength),
          }),
        },
      })
    } catch {
      throw new SttError('stt_unavailable')
    }

    return await new Promise((resolve, reject) => {
      let settled = false
      let sawResponse = false
      let timedOut = false
      let timer: ReturnType<typeof setTimeout> | undefined

      const finish = (action: () => void): void => {
        if (settled) return
        settled = true
        if (timer !== undefined) clearTimeout(timer)
        signal?.removeEventListener('abort', onAbort)
        action()
      }
      const fail = (): void => {
        if (timedOut || signal?.aborted) finish(() => reject(new SttError('stt_timeout')))
        // Once a 200 arrived, a body-read failure means the answer was truncated, not that the
        // server was unreachable.
        else if (sawResponse) finish(() => reject(new SttError('stt_protocol')))
        else finish(() => reject(new SttError('stt_unavailable')))
      }
      const onAbort = (): void => {
        request.destroy()
        fail()
      }
      const protocolFailure = (): void => {
        finish(() => reject(new SttError('stt_protocol')))
      }

      // The adapter owns the whole deadline, headers and body alike. There is no transport
      // default here: global fetch's hidden 300 s header timeout cannot fire first.
      timer = setTimeout(() => {
        timedOut = true
        request.destroy()
        fail()
      }, timeoutMs)
      signal?.addEventListener('abort', onAbort, { once: true })
      if (signal?.aborted) onAbort()

      request.on('error', fail)
      request.on('close', () => { if (!settled && !sawResponse) fail() })
      request.on('response', (response: IncomingMessage) => {
        sawResponse = true
        const status = response.statusCode ?? 0
        if (status !== 200) {
          response.resume()
          response.on('error', fail)
          response.on('aborted', fail)
          response.on('end', () => finish(() => resolve({ status, body: null })))
          return
        }

        const type = String(response.headers['content-type'] ?? '')
        if (!type.toLowerCase().startsWith('application/json')) {
          response.destroy()
          protocolFailure()
          return
        }

        const declaredHeader = response.headers['content-length']
        if (declaredHeader !== undefined) {
          const declared = Number(declaredHeader)
          if (!Number.isSafeInteger(declared) || declared < 0 || declared > this.maxResponseBytes) {
            response.destroy()
            protocolFailure()
            return
          }
        }

        const chunks: Buffer[] = []
        let size = 0
        response.on('data', (chunk: Buffer) => {
          size += chunk.byteLength
          if (size > this.maxResponseBytes) {
            response.destroy()
            protocolFailure()
            return
          }
          chunks.push(chunk)
        })
        response.on('error', fail)
        response.on('aborted', fail)
        response.on('end', () => {
          let parsed: unknown
          try {
            parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'))
          } catch {
            protocolFailure()
            return
          }
          finish(() => resolve({ status: 200, body: parsed }))
        })
      })

      try {
        request.end(init.body)
      } catch {
        request.destroy()
        fail()
      }
    })
  }

  private observedAt(): string {
    let value: Date
    try {
      value = this.now()
    } catch {
      throw new SttError('stt_unavailable')
    }
    if (!(value instanceof Date) || !Number.isFinite(value.getTime())) {
      throw new SttError('stt_unavailable')
    }
    return value.toISOString()
  }

  private assertNotAborted(signal?: AbortSignal): void {
    if (signal?.aborted) throw new SttError('stt_timeout')
  }
}
