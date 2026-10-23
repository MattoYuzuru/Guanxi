import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { glossaryFingerprint } from '../../../src/voice/stt/biasing.ts'
import {
  WHISPER_SERVER_ADAPTER,
  WHISPER_SERVER_API,
  WHISPER_SERVER_BACKEND,
  WHISPER_SERVER_MAX_PROMPT_CHARS,
  WHISPER_SERVER_MAX_TIMEOUT_MS,
  WHISPER_SERVER_RESULT_SOURCE,
  WHISPER_SERVER_SOURCE,
  WhisperServerAdapter,
  type WhisperServerAdapterOptions,
} from '../../../src/voice/stt/whisper-server.ts'
import {
  SttError,
  type SttConnection,
  type SttGlossaryEntry,
  type SttRequest,
} from '../../../src/voice/stt/types.ts'
import { glossaryRevisionHash, validateVoiceOrigin } from '../../../src/voice/marker.ts'
import {
  DEFAULT_VERBOSE_JSON,
  startFakeWhisperServer,
  type FakeWhisperRequest,
  type FakeWhisperServer,
} from './fake-whisper-server.ts'

const AUDIO = new Uint8Array([0x52, 0x49, 0x46, 0x46, 1, 2, 3, 4])
const HONO: SttGlossaryEntry = { id: 'hono', canonical: 'Hono', variants: ['хоно'], language: 'en' }
const PR: SttGlossaryEntry = { id: 'pr', canonical: 'PR', variants: ['пиар'], language: 'en' }
const LOCAL: SttConnection = { kind: 'local', glossaryConsent: false }
const CLOUD_NO_CONSENT: SttConnection = { kind: 'cloud', glossaryConsent: false }
const CLOUD_CONSENT: SttConnection = { kind: 'cloud', glossaryConsent: true }

function failure(code: string) {
  return (error: unknown) => error instanceof SttError && error.code === code
}

function request(overrides: Partial<SttRequest> = {}): SttRequest {
  return { audio: AUDIO, mimeType: 'audio/wav', ...overrides }
}

function adapter(
  fake: Pick<FakeWhisperServer, 'url'>,
  options: Partial<WhisperServerAdapterOptions> = {},
): WhisperServerAdapter {
  return new WhisperServerAdapter({ baseUrl: fake.url, model: 'large-v3', ...options })
}

function inference(fake: FakeWhisperServer): FakeWhisperRequest {
  const calls = fake.requests.filter((entry) => entry.path === WHISPER_SERVER_API.inferencePath)
  const last = calls.at(-1)
  assert.ok(last, 'the fake server received an inference request')
  return last
}

async function waitForRequest(fake: FakeWhisperServer, after = 0): Promise<void> {
  const deadline = Date.now() + 2_000
  while (fake.requests.length <= after) {
    if (Date.now() > deadline) throw new Error('the fake server did not receive the request')
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
}

describe('WhisperServerAdapter construction', () => {
  it('accepts only a bare loopback http origin with an explicit port', () => {
    for (const good of [
      'http://127.0.0.1:8080',
      'http://localhost:8080',
      'http://localhost:8080/',
      'http://[::1]:8080',
    ]) {
      assert.equal(new WhisperServerAdapter({ baseUrl: good }).baseUrl,
        new URL(good).origin)
    }
    assert.doesNotThrow(() => new WhisperServerAdapter({
      baseUrl: 'http://127.0.0.1:8080',
      requestTimeoutMs: WHISPER_SERVER_MAX_TIMEOUT_MS,
      transcribeTimeoutMs: WHISPER_SERVER_MAX_TIMEOUT_MS,
    }))
    for (const bad of [
      'http://192.168.1.5:8080',
      'http://example.com:8080',
      'https://127.0.0.1:8080',
      'http://user:pass@127.0.0.1:8080',
      'http://127.0.0.1:8080/v1',
      'http://127.0.0.1:8080/?x=1',
      'http://127.0.0.1:8080/#f',
      'http://127.0.0.1',
      'http://127.0.0.1:0',
      'http://localhost:0',
      'http://0.0.0.0:8080',
      'not a url',
    ]) {
      assert.throws(() => new WhisperServerAdapter({ baseUrl: bad }), failure('stt_unavailable'), bad)
    }
  })

  it('validates the model label, D-157 connection shape and adapter limits', () => {
    const base = 'http://127.0.0.1:8080'
    for (const options of [
      { baseUrl: base, model: '' },
      { baseUrl: base, model: '   ' },
      { baseUrl: base, connection: { kind: 'lan', glossaryConsent: true } },
      { baseUrl: base, connection: { kind: 'local' } },
      { baseUrl: base, requestTimeoutMs: 0 },
      { baseUrl: base, requestTimeoutMs: null },
      { baseUrl: base, requestTimeoutMs: WHISPER_SERVER_MAX_TIMEOUT_MS + 1 },
      { baseUrl: base, transcribeTimeoutMs: -1 },
      { baseUrl: base, transcribeTimeoutMs: WHISPER_SERVER_MAX_TIMEOUT_MS + 1 },
      { baseUrl: base, maxPromptChars: 1.5 },
      { baseUrl: base, maxPromptChars: null },
      { baseUrl: base, maxResponseBytes: 0 },
      { baseUrl: base, now: 5 },
    ]) {
      assert.throws(
        () => new WhisperServerAdapter(options as unknown as WhisperServerAdapterOptions),
        TypeError,
      )
    }
  })
})

describe('capabilities', () => {
  it('probes /health and reports documented facts, source, time and the adapter prompt budget', async (t) => {
    const fake = await startFakeWhisperServer()
    t.after(() => fake.close())
    const observedAt = '2026-01-02T03:04:05.000Z'
    let observedAfterProbe = false
    const capabilities = await adapter(fake, {
      maxPromptChars: 200,
      now: () => {
        observedAfterProbe = fake.requests.length === 1
        return new Date(observedAt)
      },
    }).capabilities()
    assert.equal(observedAfterProbe, true, 'observedAt is stamped after the health probe')

    assert.deepEqual(capabilities, {
      adapter: WHISPER_SERVER_ADAPTER,
      biasing: 'initial_prompt',
      languages: 'unknown',
      streaming: false,
      diarization: false,
      maxDurationSec: null,
      audioLeavesHost: false,
      source: WHISPER_SERVER_SOURCE,
      observedAt,
      confidence: 'documented',
      maxPromptChars: 200,
    })
    assert.equal(WHISPER_SERVER_ADAPTER, 'whisper.cpp-server')
    assert.equal(WHISPER_SERVER_BACKEND, 'whisper.cpp')
    assert.equal(WHISPER_SERVER_SOURCE,
      'https://github.com/ggml-org/whisper.cpp/tree/61e6ccade0849f0f518c6decd1f25b3f9fb77b76/examples/server')
    assert.equal(WHISPER_SERVER_RESULT_SOURCE, 'whisper.cpp-server:/inference verbose_json')
    assert.equal(WHISPER_SERVER_MAX_PROMPT_CHARS, 448)
    assert.deepEqual(WHISPER_SERVER_API, {
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
    assert.equal(fake.requests.length, 1)
    assert.equal(fake.requests[0]!.method, 'GET')
    assert.equal(fake.requests[0]!.path, '/health')
  })

  it('uses the documented default prompt budget when the caller supplies none', async (t) => {
    const fake = await startFakeWhisperServer()
    t.after(() => fake.close())
    const capabilities = await adapter(fake).capabilities()
    assert.equal(capabilities.maxPromptChars, WHISPER_SERVER_MAX_PROMPT_CHARS)
  })

  it('maps loading to unavailable and malformed health answers to protocol without echoing them', async (t) => {
    const fake = await startFakeWhisperServer()
    t.after(() => fake.close())
    const client = adapter(fake)

    fake.setHealth({ status: 503, body: { status: 'loading model' } })
    await assert.rejects(client.capabilities(), failure('stt_unavailable'))

    for (const reply of [
      { status: 200, body: { status: 'loading model' } },
      { status: 200, body: { status: 5 } },
      { status: 500, body: { error: 'secret health text' } },
      { status: 200, contentType: 'text/html', body: 'secret health text' },
      { status: 200, contentType: 'application/json', body: '{not json' },
    ]) {
      fake.setHealth(reply)
      await assert.rejects(client.capabilities(), (error: unknown) => {
        assert.ok(error instanceof SttError)
        assert.equal(error.code, 'stt_protocol')
        assert.equal(String(error.message).includes('secret'), false)
        return true
      })
    }
  })

  it('maps a slow, pre-aborted or aborted health probe to timeout', async (t) => {
    const fake = await startFakeWhisperServer({ health: { body: { status: 'ok' }, delayMs: 300 } })
    t.after(() => fake.close())

    await assert.rejects(
      adapter(fake, { requestTimeoutMs: 30 }).capabilities(),
      failure('stt_timeout'),
    )

    const before = new AbortController()
    before.abort()
    const count = fake.requests.length
    await assert.rejects(adapter(fake).capabilities(before.signal), failure('stt_timeout'))
    assert.equal(fake.requests.length, count, 'an already-aborted call sends nothing')

    const controller = new AbortController()
    const requestCount = fake.requests.length
    const pending = adapter(fake).capabilities(controller.signal)
    await waitForRequest(fake, requestCount)
    controller.abort()
    await assert.rejects(pending, failure('stt_timeout'))
  })

  it('reports an unreachable server as unavailable', async () => {
    await assert.rejects(
      new WhisperServerAdapter({ baseUrl: 'http://127.0.0.1:1' }).capabilities(),
      failure('stt_unavailable'),
    )
  })
})

describe('transcribe happy path', () => {
  it('sends exactly the documented multipart fields and parses verbose_json', async (t) => {
    const fake = await startFakeWhisperServer()
    t.after(() => fake.close())
    const client = adapter(fake)
    const result = await client.transcribe(request({ language: 'ru', glossary: [HONO, PR] }))

    const call = inference(fake)
    assert.equal(call.method, 'POST')
    assert.equal(call.target, '/inference')
    assert.equal(Object.hasOwn(call.headers, 'authorization'), false)
    assert.deepEqual(call.fieldOrder, ['file', 'response_format', 'language', 'prompt'])
    assert.deepEqual(call.fields, {
      response_format: 'verbose_json',
      language: 'ru',
      prompt: 'Hono, PR',
    })
    assert.equal(call.files.length, 1)
    assert.equal(call.files[0]!.field, 'file')
    assert.equal(call.files[0]!.filename, 'audio.wav')
    assert.equal(call.files[0]!.contentType, 'audio/wav')
    assert.deepEqual(call.files[0]!.bytes, AUDIO)

    assert.equal(result.text, DEFAULT_VERBOSE_JSON.text)
    assert.equal(result.language, 'en')
    assert.equal(result.durationSec, 1)
    assert.equal(result.source, WHISPER_SERVER_RESULT_SOURCE)
    assert.equal(result.biasing, 'initial_prompt')
    assert.deepEqual(result.segments, [{
      start: 0,
      end: 1,
      text: ' hello',
      confidence: Math.exp(-0.1) * 0.99,
    }])
    assert.deepEqual(result.origin, {
      origin: 'voice',
      backend: 'whisper.cpp',
      model: 'large-v3',
      language: 'en',
      confidenceSpans: [{ start: 0, end: 6, confidence: Math.exp(-0.1) * 0.99 }],
      replacements: [],
      glossaryRevision: glossaryFingerprint([HONO, PR]),
    })
    assert.deepEqual(validateVoiceOrigin(result.origin, result.text), result.origin)
  })

  it('sends auto language and the MIME-derived filename when the request omits a language', async (t) => {
    const fake = await startFakeWhisperServer()
    t.after(() => fake.close())
    const client = adapter(fake)
    const cases = [
      ['audio/wav', 'audio.wav'],
      ['audio/ogg', 'audio.ogg'],
      ['audio/mpeg', 'audio.mp3'],
      ['audio/webm', 'audio.webm'],
    ] as const
    for (const [mimeType, filename] of cases) {
      const result = await client.transcribe(request({ mimeType }))
      const call = inference(fake)
      assert.deepEqual(call.fieldOrder, ['file', 'response_format', 'language'])
      assert.equal(call.fields.language, 'auto')
      assert.equal(Object.hasOwn(call.fields, 'prompt'), false)
      assert.equal(call.files[0]!.filename, filename)
      assert.equal(call.files[0]!.contentType, mimeType)
      assert.equal(result.biasing, 'none')
    }
  })

  it('applies deterministic replacement and builds a valid origin across changing lengths', async (t) => {
    const fake = await startFakeWhisperServer({
      inference: {
        body: {
          language: 'russian',
          duration: 3,
          text: 'пиар и хоно!',
          segments: [
            { start: 0, end: 1.5, text: 'пиар и ', avg_logprob: -0.2, no_speech_prob: 0.1 },
            { start: 1.5, end: 3, text: 'хоно!', avg_logprob: -0.4, no_speech_prob: 0.2 },
          ],
        },
      },
    })
    t.after(() => fake.close())
    const result = await adapter(fake).transcribe(request({ glossary: [PR, HONO] }))

    assert.equal(result.text, 'PR и Hono!')
    assert.deepEqual(result.segments.map((segment) => segment.text), ['пиар и ', 'хоно!'])
    assert.deepEqual(result.origin.replacements, [
      { start: 0, end: 2, original: 'пиар', replacement: 'PR', entryId: 'pr' },
      { start: 5, end: 9, original: 'хоно', replacement: 'Hono', entryId: 'hono' },
    ])
    assert.deepEqual(result.origin.confidenceSpans, [
      { start: 0, end: 5, confidence: Math.exp(-0.2) * 0.9 },
      { start: 5, end: 10, confidence: Math.exp(-0.4) * 0.8 },
    ])
    assert.equal(result.origin.glossaryRevision, glossaryFingerprint([PR, HONO]))
    assert.deepEqual(validateVoiceOrigin(result.origin, result.text), result.origin)
  })

  it('clamps a replacement that crosses a segment boundary into one valid confidence span', async (t) => {
    const fake = await startFakeWhisperServer({
      inference: {
        body: {
          text: 'пиар',
          language: 'russian',
          duration: 1,
          segments: [
            { start: 0, end: 0.5, text: 'пи', avg_logprob: -0.1 },
            { start: 0.5, end: 1, text: 'ар', avg_logprob: -0.2 },
          ],
        },
      },
    })
    t.after(() => fake.close())
    const result = await adapter(fake).transcribe(request({ glossary: [PR] }))
    assert.equal(result.text, 'PR')
    assert.deepEqual(result.origin.replacements, [
      { start: 0, end: 2, original: 'пиар', replacement: 'PR', entryId: 'pr' },
    ])
    assert.equal(result.origin.confidenceSpans.length, 1)
    assert.equal(result.origin.confidenceSpans[0]!.start, 0)
    assert.equal(result.origin.confidenceSpans[0]!.end, 2)
    assert.deepEqual(validateVoiceOrigin(result.origin, result.text), result.origin)
  })

  it('keeps confidence null when the backend reports no signal and uses a single signal alone', async (t) => {
    const fake = await startFakeWhisperServer({
      inference: {
        body: {
          text: ' alpha beta gamma delta',
          language: 'english',
          duration: 4,
          segments: [
            { start: 0, end: 1, text: ' alpha', avg_logprob: -1, no_speech_prob: 0.5 },
            { start: 1, end: 2, text: ' beta', avg_logprob: -2 },
            { start: 2, end: 3, text: ' gamma', no_speech_prob: 0.25 },
            { start: 3, end: 4, text: ' delta' },
          ],
        },
      },
    })
    t.after(() => fake.close())
    const result = await adapter(fake).transcribe(request())

    assert.deepEqual(result.segments.map((segment) => segment.confidence), [
      Math.exp(-1) * 0.5,
      Math.exp(-2),
      0.75,
      null,
    ])
    assert.deepEqual(result.origin.confidenceSpans, [
      { start: 0, end: 6, confidence: Math.exp(-1) * 0.5 },
      { start: 6, end: 11, confidence: Math.exp(-2) },
      { start: 11, end: 17, confidence: 0.75 },
    ])
    assert.deepEqual(validateVoiceOrigin(result.origin, result.text), result.origin)
  })

  it('advances past a null-confidence segment so a later duplicate maps to its own occurrence', async (t) => {
    const fake = await startFakeWhisperServer({
      inference: {
        body: {
          text: ' hello hello',
          language: 'english',
          duration: 1,
          segments: [
            { start: 0, end: 0.5, text: ' hello' },
            { start: 0.5, end: 1, text: ' hello', avg_logprob: -0.5 },
          ],
        },
      },
    })
    t.after(() => fake.close())
    const result = await adapter(fake).transcribe(request())
    assert.deepEqual(result.segments.map((segment) => segment.confidence), [null, Math.exp(-0.5)])
    assert.deepEqual(result.origin.confidenceSpans, [{
      start: 6,
      end: 12,
      confidence: Math.exp(-0.5),
    }])
    assert.deepEqual(validateVoiceOrigin(result.origin, result.text), result.origin)
  })

  it('clamps an extreme finite log-probability instead of producing a NaN confidence', async (t) => {
    const fake = await startFakeWhisperServer({
      inference: {
        body: {
          text: 'alpha',
          language: 'english',
          duration: 1,
          segments: [{ start: 0, end: 1, text: 'alpha', avg_logprob: 1e308, no_speech_prob: 1 }],
        },
      },
    })
    t.after(() => fake.close())
    const result = await adapter(fake).transcribe(request())
    assert.equal(result.segments[0]!.confidence, 0)
    assert.deepEqual(result.origin.confidenceSpans, [{ start: 0, end: 5, confidence: 0 }])
    assert.deepEqual(validateVoiceOrigin(result.origin, result.text), result.origin)
  })

  it('maps newline-separated output_str text to the corresponding segments', async (t) => {
    const fake = await startFakeWhisperServer({
      inference: {
        body: {
          text: ' alpha\n beta\n',
          language: 'english',
          duration: 2,
          segments: [
            { start: 0, end: 1, text: ' alpha', avg_logprob: -0.1 },
            { start: 1, end: 2, text: ' beta', avg_logprob: -0.2 },
          ],
        },
      },
    })
    t.after(() => fake.close())
    const result = await adapter(fake).transcribe(request())
    assert.equal(result.text, ' alpha\n beta\n')
    assert.deepEqual(result.origin.confidenceSpans, [
      { start: 0, end: 6, confidence: Math.exp(-0.1) },
      { start: 7, end: 12, confidence: Math.exp(-0.2) },
    ])
    assert.deepEqual(validateVoiceOrigin(result.origin, result.text), result.origin)
  })

  it('does not invent a language, duration or confidence the backend omitted', async (t) => {
    const fake = await startFakeWhisperServer({
      inference: { body: { text: 'hello', segments: [{ start: 0, end: 1, text: 'hello' }] } },
    })
    t.after(() => fake.close())
    const result = await adapter(fake).transcribe(request())

    assert.equal(result.language, null)
    assert.equal(result.durationSec, null)
    assert.equal(result.segments[0]!.confidence, null)
    assert.equal(result.origin.language, null)
    assert.deepEqual(result.origin.confidenceSpans, [])
    assert.deepEqual(validateVoiceOrigin(result.origin, result.text), result.origin)
  })

  it('skips a segment whose text is not present in the transcript but keeps the segment', async (t) => {
    const fake = await startFakeWhisperServer({
      inference: {
        body: {
          text: 'hello world',
          language: 'english',
          duration: 1,
          segments: [{ start: 0, end: 1, text: 'missing', avg_logprob: -0.1 }],
        },
      },
    })
    t.after(() => fake.close())
    const result = await adapter(fake).transcribe(request())

    assert.equal(result.segments.length, 1)
    assert.equal(result.segments[0]!.text, 'missing')
    assert.notEqual(result.segments[0]!.confidence, null)
    assert.deepEqual(result.origin.confidenceSpans, [])
    assert.deepEqual(validateVoiceOrigin(result.origin, result.text), result.origin)
  })

  it('uses stored entry revisions for the origin hash when the service supplied them', async (t) => {
    const fake = await startFakeWhisperServer()
    t.after(() => fake.close())
    const result = await adapter(fake).transcribe(request({
      glossary: [{ ...HONO, revision: 2 }, { ...PR, revision: 5 }],
    }))
    assert.equal(
      result.origin.glossaryRevision,
      glossaryRevisionHash([{ id: 'hono', revision: 2 }, { id: 'pr', revision: 5 }]),
    )
  })

  it('records the caller model label and falls back to unknown, because the server exposes no model', async (t) => {
    const fake = await startFakeWhisperServer()
    t.after(() => fake.close())
    const named = await adapter(fake).transcribe(request())
    assert.equal(named.origin.model, 'large-v3')
    const unnamed = await new WhisperServerAdapter({ baseUrl: fake.url }).transcribe(request())
    assert.equal(unnamed.origin.model, 'unknown')
  })

  it('honours the adapter maxPromptChars and sends no empty prompt field', async (t) => {
    const fake = await startFakeWhisperServer()
    t.after(() => fake.close())
    const budgeted = await adapter(fake, { maxPromptChars: 12 }).transcribe(request({
      glossary: [HONO, PR, { id: 'zeta', canonical: 'Zeta', variants: [], language: 'en' }],
    }))
    const call = inference(fake)
    assert.equal(call.fields.prompt, 'Hono, PR')
    assert.ok([...(call.fields.prompt ?? '')].length <= 12)
    assert.equal(budgeted.biasing, 'initial_prompt')

    const none = await adapter(fake, { maxPromptChars: 1 }).transcribe(request({ glossary: [HONO] }))
    const last = inference(fake)
    assert.equal(Object.hasOwn(last.fields, 'prompt'), false)
    assert.equal(none.biasing, 'none')
  })
})

describe('D-157 withholding', () => {
  it('sends no prompt for a cloud connection without consent but still replaces locally', async (t) => {
    const fake = await startFakeWhisperServer({
      inference: {
        body: {
          text: 'хоно',
          language: 'russian',
          duration: 1,
          segments: [{ start: 0, end: 1, text: 'хоно', avg_logprob: -0.1, no_speech_prob: 0.2 }],
        },
      },
    })
    t.after(() => fake.close())
    const result = await adapter(fake, { connection: CLOUD_NO_CONSENT }).transcribe(
      request({ glossary: [HONO] }),
    )

    const call = inference(fake)
    assert.equal(call.target, '/inference')
    assert.equal(Object.hasOwn(call.headers, 'authorization'), false)
    assert.deepEqual(call.fields, { response_format: 'verbose_json', language: 'auto' })
    assert.deepEqual(call.fieldOrder, ['file', 'response_format', 'language'])
    assert.equal(Object.hasOwn(call.fields, WHISPER_SERVER_API.promptField), false)
    assert.equal(result.biasing, 'withheld_no_consent')
    assert.equal(result.text, 'Hono')
    assert.equal(result.origin.replacements.length, 1)
    assert.equal(result.origin.replacements[0]!.replacement, 'Hono')
    assert.deepEqual(validateVoiceOrigin(result.origin, result.text), result.origin)
  })

  it('sends the prompt for a cloud connection with explicit consent', async (t) => {
    const fake = await startFakeWhisperServer()
    t.after(() => fake.close())
    const result = await adapter(fake, { connection: CLOUD_CONSENT }).transcribe(
      request({ glossary: [HONO] }),
    )
    assert.equal(inference(fake).fields.prompt, 'Hono')
    assert.equal(result.biasing, 'initial_prompt')
  })

  it('sends the prompt for a local connection without a cloud consent flag', async (t) => {
    const fake = await startFakeWhisperServer()
    t.after(() => fake.close())
    const result = await adapter(fake, { connection: LOCAL }).transcribe(request({ glossary: [HONO] }))
    assert.equal(inference(fake).fields.prompt, 'Hono')
    assert.equal(result.biasing, 'initial_prompt')
  })
})

describe('request and transport failures', () => {
  it('rejects invalid audio before any network request', async (t) => {
    const fake = await startFakeWhisperServer()
    t.after(() => fake.close())
    const client = adapter(fake)
    for (const bad of [
      { audio: new Uint8Array(), mimeType: 'audio/wav' },
      { audio: 'audio', mimeType: 'audio/wav' },
      { audio: AUDIO, mimeType: 'audio/flac' },
      { audio: AUDIO, mimeType: undefined },
      { audio: AUDIO },
    ]) {
      await assert.rejects(
        client.transcribe(bad as unknown as SttRequest),
        failure('stt_audio_invalid'),
      )
    }
    await assert.rejects(client.transcribe(null as unknown as SttRequest), failure('stt_audio_invalid'))
    assert.equal(fake.requests.length, 0)
  })

  it('rejects an invalid glossary or language as protocol before any audio leaves the process', async (t) => {
    const fake = await startFakeWhisperServer()
    t.after(() => fake.close())
    const client = adapter(fake)
    for (const bad of [
      request({ glossary: [HONO, { ...PR, id: 'hono' }] }),
      request({ glossary: [{ id: 'hono', canonical: 'Hono', variants: [], language: 'xx' } as unknown as SttGlossaryEntry] }),
      request({ language: '   ' }),
    ]) {
      await assert.rejects(client.transcribe(bad), (error: unknown) => {
        assert.ok(error instanceof SttError)
        assert.equal(error.code, 'stt_protocol')
        assert.equal(String(error.message).includes('Hono'), false)
        return true
      })
    }
    assert.equal(fake.requests.length, 0)
  })

  it('accepts short BCP-47 language codes and rejects full names or loose shapes', async (t) => {
    const fake = await startFakeWhisperServer()
    t.after(() => fake.close())
    const client = adapter(fake)
    for (const language of ['ru', 'en-US', 'zh-Hant-TW', 'und']) {
      await client.transcribe(request({ language }))
      assert.equal(inference(fake).fields.language, language)
    }
    const sent = fake.requests.length
    for (const language of ['EN', 'e', 'english', 'en_US', 'en--US', 'ru ', 'ru\n', '']) {
      await assert.rejects(client.transcribe(request({ language })), failure('stt_protocol'))
    }
    assert.equal(fake.requests.length, sent, 'an invalid language sends no audio')
  })

  it('normalizes whisper full language names to codes and never invents an unknown one', async (t) => {
    const fake = await startFakeWhisperServer()
    t.after(() => fake.close())
    for (const [reported, expected] of [
      ['russian', 'ru'],
      ['english', 'en'],
      ['ukrainian', 'uk'],
      ['de', 'de'],
      ['klingon', null],
    ] as const) {
      fake.setInference({ body: { ...DEFAULT_VERBOSE_JSON, language: reported } })
      const result = await adapter(fake).transcribe(request())
      assert.equal(result.language, expected, reported)
      assert.equal(result.origin.language, expected, reported)
    }
    fake.setInference({ body: { text: 'hello', segments: [] } })
    const missing = await adapter(fake).transcribe(request())
    assert.equal(missing.language, null)
    assert.equal(missing.origin.language, null)
  })

  it('maps malformed inference answers to protocol without echoing the body', async (t) => {
    const fake = await startFakeWhisperServer()
    t.after(() => fake.close())
    const client = adapter(fake)
    for (const reply of [
      { status: 200, contentType: 'text/html', body: 'secret transcript text' },
      { status: 200, contentType: 'application/json', body: '{"secret transcript' },
      { status: 200, body: { segments: [] } },
      { status: 200, body: { text: 'x', segments: 'no' } },
      { status: 200, body: { text: 'x', segments: [{ start: 0, end: 1, text: 'x', avg_logprob: 'secret' }] } },
      { status: 200, body: { text: 'x', segments: [{ start: 2, end: 1, text: 'x' }] } },
      { status: 200, body: { text: 5, segments: [] } },
      { status: 500, body: { error: 'secret transcript text' } },
    ]) {
      fake.setInference(reply)
      await assert.rejects(client.transcribe(request()), (error: unknown) => {
        assert.ok(error instanceof SttError)
        assert.equal(error.code, 'stt_protocol')
        assert.equal(String(error).includes('secret'), false)
        assert.equal(String(error).includes('transcript'), false)
        return true
      })
    }
  })

  it('maps a loading inference answer to unavailable and an oversized answer to protocol', async (t) => {
    const fake = await startFakeWhisperServer()
    t.after(() => fake.close())
    fake.setInference({ status: 503, body: { status: 'loading model' } })
    await assert.rejects(adapter(fake).transcribe(request()), failure('stt_unavailable'))

    fake.setInference({ body: { text: 'x'.repeat(200), segments: [] } })
    await assert.rejects(
      adapter(fake, { maxResponseBytes: 100 }).transcribe(request()),
      failure('stt_protocol'),
    )
  })

  it('maps HTTP 400 from /inference to audio_invalid without echoing the body', async (t) => {
    const fake = await startFakeWhisperServer({
      inference: { status: 400, body: { error: 'audio decode secret' } },
    })
    t.after(() => fake.close())
    await assert.rejects(adapter(fake).transcribe(request()), (error: unknown) => {
      assert.ok(error instanceof SttError)
      assert.equal(error.code, 'stt_audio_invalid')
      assert.equal(String(error).includes('secret'), false)
      return true
    })
  })

  it('refuses a redirect instead of following it to another loopback server', async (t) => {
    const target = await startFakeWhisperServer()
    t.after(() => target.close())
    const source = await startFakeWhisperServer({
      inference: { status: 302, headers: { location: `${target.url}/inference` }, body: '' },
    })
    t.after(() => source.close())
    await assert.rejects(adapter(source).transcribe(request()), failure('stt_unavailable'))
    assert.equal(source.requests.length, 1)
    assert.equal(target.requests.length, 0, 'the redirect target was never contacted')
  })

  it('caps a chunked answer even when the server omits Content-Length', async (t) => {
    const fake = await startFakeWhisperServer({
      inference: {
        contentLength: null,
        chunks: ['{"text":"', 'x'.repeat(200), '","segments":[]}'],
      },
    })
    t.after(() => fake.close())
    await assert.rejects(
      adapter(fake, { maxResponseBytes: 100 }).transcribe(request()),
      failure('stt_protocol'),
    )
  })

  it('aborts while the body is still streaming', async (t) => {
    const fake = await startFakeWhisperServer({
      inference: {
        contentLength: null,
        chunks: ['{"text":"', 'x'.repeat(100), 'x'.repeat(100)],
        chunkDelayMs: 50,
      },
    })
    t.after(() => fake.close())
    await assert.rejects(
      adapter(fake, { transcribeTimeoutMs: 30 }).transcribe(request()),
      failure('stt_timeout'),
    )
  })

  it('maps a truncated 200 body to protocol, not unavailable', async (t) => {
    const fake = await startFakeWhisperServer({
      inference: { body: { text: 'x'.repeat(100), segments: [] }, truncate: true },
    })
    t.after(() => fake.close())
    await assert.rejects(adapter(fake).transcribe(request()), failure('stt_protocol'))
  })

  it('sends one attempt per call and never retries', async (t) => {
    const fake = await startFakeWhisperServer()
    t.after(() => fake.close())
    fake.setInference({ status: 500, body: { error: 'x' } })
    await assert.rejects(adapter(fake).transcribe(request()), failure('stt_protocol'))
    assert.equal(fake.requests.length, 1)
    fake.setInference({ status: 503, body: { error: 'x' } })
    await assert.rejects(adapter(fake).transcribe(request()), failure('stt_unavailable'))
    assert.equal(fake.requests.length, 2)
    fake.setInference({ body: DEFAULT_VERBOSE_JSON, delayMs: 300 })
    await assert.rejects(
      adapter(fake, { transcribeTimeoutMs: 30 }).transcribe(request()),
      failure('stt_timeout'),
    )
    assert.equal(fake.requests.length, 3)
  })

  it('does not log audio, transcripts or glossary terms on success or failure', async (t) => {
    const fake = await startFakeWhisperServer()
    t.after(() => fake.close())
    const calls: string[] = []
    for (const method of ['log', 'info', 'warn', 'error', 'debug'] as const) {
      t.mock.method(console, method, (...args: unknown[]) => {
        calls.push(`${method}:${args.map(String).join(' ')}`)
      })
    }
    const result = await adapter(fake).transcribe(request({ glossary: [HONO] }))
    assert.equal(result.text, DEFAULT_VERBOSE_JSON.text)
    fake.setInference({ status: 500, body: { error: 'transcript secret' } })
    await assert.rejects(adapter(fake).transcribe(request({ glossary: [HONO] })), failure('stt_protocol'))
    assert.deepEqual(calls, [])
  })

  it('maps a slow inference to timeout', async (t) => {
    const fake = await startFakeWhisperServer({ inference: { body: DEFAULT_VERBOSE_JSON, delayMs: 300 } })
    t.after(() => fake.close())
    await assert.rejects(
      adapter(fake, { transcribeTimeoutMs: 30 }).transcribe(request()),
      failure('stt_timeout'),
    )
  })

  it('does not inherit global fetch\'s hidden 300 s header timeout', async (t) => {
    const fake = await startFakeWhisperServer()
    t.after(() => fake.close())
    const hiddenCap = Object.assign(new Error('headers timeout'), {
      name: 'HeadersTimeoutError',
      code: 'UND_ERR_HEADERS_TIMEOUT',
    })
    t.mock.method(globalThis, 'fetch', async () => { throw hiddenCap })
    const result = await adapter(fake, { transcribeTimeoutMs: 2_000 }).transcribe(request())
    assert.equal(result.text, DEFAULT_VERBOSE_JSON.text)
    assert.equal(fake.requests.length, 1)
  })

  it('maps a header delay past the adapter deadline to timeout, not unavailable', async (t) => {
    const fake = await startFakeWhisperServer({
      inference: { body: DEFAULT_VERBOSE_JSON, delayMs: 1_000 },
    })
    t.after(() => fake.close())
    const started = Date.now()
    await assert.rejects(
      adapter(fake, { transcribeTimeoutMs: 300 }).transcribe(request()),
      failure('stt_timeout'),
    )
    const elapsed = Date.now() - started
    assert.ok(elapsed >= 250, `waited for most of the deadline (${elapsed} ms)`)
    assert.ok(elapsed < 900, `did not wait for the delayed headers (${elapsed} ms)`)
  })

  it('succeeds when headers arrive inside a longer adapter deadline', async (t) => {
    const fake = await startFakeWhisperServer({
      inference: { body: DEFAULT_VERBOSE_JSON, delayMs: 1_000 },
    })
    t.after(() => fake.close())
    const result = await adapter(fake, { transcribeTimeoutMs: 2_000 }).transcribe(request())
    assert.equal(result.text, DEFAULT_VERBOSE_JSON.text)
  })

  it('maps a caller abort during inference to timeout', async (t) => {
    const fake = await startFakeWhisperServer({ inference: { body: DEFAULT_VERBOSE_JSON, delayMs: 500 } })
    t.after(() => fake.close())
    const controller = new AbortController()
    const pending = adapter(fake).transcribe(request(), controller.signal)
    await waitForRequest(fake)
    controller.abort()
    await assert.rejects(pending, failure('stt_timeout'))
  })

  it('does not send a pre-aborted transcription request', async (t) => {
    const fake = await startFakeWhisperServer()
    t.after(() => fake.close())
    const controller = new AbortController()
    controller.abort()
    await assert.rejects(
      adapter(fake).transcribe(request(), controller.signal),
      failure('stt_timeout'),
    )
    assert.equal(fake.requests.length, 0)
  })

  it('reports an unreachable inference endpoint as unavailable', async () => {
    await assert.rejects(
      new WhisperServerAdapter({ baseUrl: 'http://127.0.0.1:1' }).transcribe(request()),
      failure('stt_unavailable'),
    )
  })

  it('never includes audio or transcript text in a thrown error', async (t) => {
    const fake = await startFakeWhisperServer({
      inference: { status: 500, body: { error: 'transcript secret' } },
    })
    t.after(() => fake.close())
    await assert.rejects(adapter(fake).transcribe(request()), (error: unknown) => {
      assert.ok(error instanceof SttError)
      assert.equal(error.message, 'stt_protocol')
      assert.equal(String(error).includes('transcript'), false)
      assert.equal(String(error).includes('secret'), false)
      assert.equal(String(error).includes(Buffer.from(AUDIO).toString('latin1')), false)
      return true
    })
  })
})
