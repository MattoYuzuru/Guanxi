import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  huggingFaceRepositoryResultSchema,
  huggingFaceSearchResultSchema,
} from '@alamo/contract'
import { normalizeHuggingFaceReference } from '../src/models/hugging-face-reference.ts'
import {
  HUGGING_FACE_MAX_FILE_ENTRIES,
  HuggingFaceTransport,
  decideVerdict,
  nextCursorFromLink,
} from '../src/models/hugging-face-transport.ts'

const OBSERVED_AT = '2026-08-07T12:00:00.000Z'
const now = () => new Date(OBSERVED_AT)
const SHA = 'a'.repeat(40)

function json(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
    ...init,
  })
}

function hubRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'TheBloke/Llama-2-7B-GGUF',
    sha: SHA,
    gated: false,
    tags: ['license:apache-2.0', 'text-generation'],
    siblings: [
      { rfilename: 'README.md', size: 10 },
      { rfilename: 'llama-2-7b.Q4_K_M.gguf', size: 4_000 },
    ],
    ...overrides,
  }
}

/** A transport whose only outbound edge is this recorded fake fetch. */
function transportWith(
  handler: (url: string, init: RequestInit | undefined) => Promise<Response>,
  options: Record<string, unknown> = {},
) {
  const calls: Array<{ url: string; init: RequestInit | undefined }> = []
  const fetchImpl = (async (input: unknown, init?: RequestInit) => {
    const url = String(input)
    calls.push({ url, init })
    return handler(url, init)
  }) as typeof fetch
  return {
    calls,
    transport: new HuggingFaceTransport({ fetch: fetchImpl, now, ...options }),
  }
}

const preview = () => normalizeHuggingFaceReference('TheBloke/Llama-2-7B-GGUF')

describe('bounded server-owned Hugging Face transport', () => {
  it('issues one anonymous bounded request per explicit search and never sends credentials', async () => {
    const { calls, transport } = transportWith(async () => json([hubRow()]))
    const result = await transport.search({
      query: 'llama gguf', page: 1, pageSize: 10, cursor: null,
    })

    assert.equal(calls.length, 1)
    const call = calls[0]!
    const url = new URL(call.url)
    assert.equal(url.origin, 'https://huggingface.co')
    assert.equal(url.pathname, '/api/models')
    assert.equal(url.searchParams.get('search'), 'llama gguf')
    assert.equal(url.searchParams.get('limit'), '10')
    assert.equal(url.searchParams.get('full'), 'true')
    assert.equal(url.searchParams.has('blobs'), false)
    // Anonymous public access only: no token may be attached in this slice.
    const headers = new Headers(call.init?.headers as Record<string, string>)
    assert.equal(headers.get('authorization'), null)
    assert.equal(headers.get('cookie'), null)
    assert.equal(JSON.stringify(call.init?.headers).toLowerCase().includes('token'), false)
    // A redirect must not silently move the read to another origin.
    assert.equal(call.init?.redirect, 'error')

    assert.equal(result.state, 'listed')
    assert.deepEqual(huggingFaceSearchResultSchema.parse(result), result)
  })

  it('publishes exact GGUF evidence as supported and never as an installable promise', async () => {
    const { transport } = transportWith(async () => json([hubRow()]))
    const result = await transport.search({
      query: 'llama', page: 1, pageSize: 10, cursor: null,
    })
    assert.equal(result.state, 'listed')
    const [repository] = result.repositories
    assert.ok(repository)
    assert.equal(repository.metadata, 'resolved')
    assert.equal(repository.observedAt, OBSERVED_AT)
    assert.equal(repository.verdict.state, 'supported')
    assert.equal(repository.verdict.basis, 'exact_gguf_files_listed')
    assert.equal(repository.verdict.scope, 'exact_gguf_file_only')
    // Even a supported repository still requires the P2-K exact file choice.
    assert.equal(repository.verdict.requiresExactFileSelection, true)
    assert.equal(repository.files.state, 'listed')
    assert.deepEqual(
      repository.files.ggufFiles.map((file) => file.path),
      ['llama-2-7b.Q4_K_M.gguf'],
    )
    assert.equal(repository.revision.state, 'exact_commit')
    assert.equal(repository.revision.commit, SHA)
    assert.equal(repository.license.state, 'declared')
    assert.equal(repository.license.value, 'apache-2.0')
    assert.equal(repository.gated.state, 'open')
  })

  it('separates no-GGUF, truncated, malformed and empty listings', async () => {
    const cases: Array<[string, unknown, string, string | null]> = [
      [
        'complete listing without gguf',
        [hubRow({ siblings: [{ rfilename: 'model.safetensors', size: 1 }] })],
        'unsupported',
        null,
      ],
      [
        'zero files listed',
        [hubRow({ siblings: [] })],
        'unsupported',
        null,
      ],
      [
        'mixed listing keeps only exact gguf',
        [hubRow({ siblings: [
          { rfilename: 'model.safetensors', size: 1 },
          { rfilename: 'weights.gguf', size: 2 },
        ] })],
        'supported',
        null,
      ],
      [
        'malformed entries without gguf cannot prove absence',
        [hubRow({ siblings: [{ rfilename: 42 }, { nope: true }] })],
        'unknown',
        'file_entries_malformed',
      ],
      [
        'missing siblings field is unknown, not unsupported',
        [{ id: 'a/b', sha: SHA, gated: false, tags: [] }],
        'unknown',
        'file_inventory_unavailable',
      ],
      [
        'malformed siblings field is unknown, not unsupported',
        [hubRow({ siblings: 'nope' })],
        'unknown',
        'file_entries_malformed',
      ],
    ]

    for (const [label, payload, expectedState, expectedReason] of cases) {
      const { transport } = transportWith(async () => json(payload))
      const result = await transport.search({
        query: 'x', page: 1, pageSize: 10, cursor: null,
      })
      assert.equal(result.state, 'listed', label)
      const repository = result.repositories[0]
      assert.ok(repository, label)
      assert.equal(repository.verdict.state, expectedState, label)
      assert.equal(repository.verdict.reason, expectedReason, label)
      assert.deepEqual(huggingFaceSearchResultSchema.parse(result), result, label)
    }
  })

  it('treats a truncated oversized listing as unknown rather than unsupported', async () => {
    const siblings = Array.from(
      { length: HUGGING_FACE_MAX_FILE_ENTRIES + 5 },
      (_unused, index) => ({ rfilename: `shard-${index}.safetensors`, size: 1 }),
    )
    const { transport } = transportWith(async () => json([hubRow({ siblings })]))
    const result = await transport.search({
      query: 'x', page: 1, pageSize: 10, cursor: null,
    })
    assert.equal(result.state, 'listed')
    const repository = result.repositories[0]!
    assert.equal(repository.files.state, 'listed')
    assert.equal(repository.files.truncated, true)
    assert.equal(repository.files.totalFiles, HUGGING_FACE_MAX_FILE_ENTRIES)
    // No GGUF was seen, but the listing was cut: that is not proof of absence.
    assert.equal(repository.verdict.state, 'unknown')
    assert.equal(repository.verdict.reason, 'file_listing_truncated')
  })

  it('keeps a large in-bounds gguf listing supported and deduplicates paths', async () => {
    const siblings = Array.from(
      { length: HUGGING_FACE_MAX_FILE_ENTRIES },
      (_unused, index) => ({ rfilename: `q${index}.gguf`, size: index }),
    )
    siblings.push({ rfilename: 'q0.gguf', size: 0 })
    const { transport } = transportWith(async () => json([hubRow({ siblings })]))
    const result = await transport.search({
      query: 'x', page: 1, pageSize: 10, cursor: null,
    })
    assert.equal(result.state, 'listed')
    const repository = result.repositories[0]!
    assert.equal(repository.files.truncated, true)
    assert.equal(repository.verdict.state, 'supported')
    const paths = repository.files.ggufFiles.map((file) => file.path)
    assert.equal(new Set(paths).size, paths.length, 'gguf paths must be unique')
  })

  it('does not let gated state or license change the support verdict', async () => {
    for (const gated of [false, true, 'auto', 'manual', undefined, 'weird']) {
      for (const tags of [['license:mit'], [], ['license:mit', 'license:apache-2.0']]) {
        const row = hubRow({ gated, tags })
        if (gated === undefined) delete (row as Record<string, unknown>)['gated']
        const { transport } = transportWith(async () => json([row]))
        const result = await transport.search({
          query: 'x', page: 1, pageSize: 10, cursor: null,
        })
        assert.equal(result.state, 'listed')
        const repository = result.repositories[0]!
        // The GGUF evidence is unchanged across every gated/license combination.
        assert.equal(
          repository.verdict.state,
          'supported',
          `gated=${String(gated)} tags=${tags.join('|')}`,
        )
      }
    }
  })

  it('reports gated and conflicting license states truthfully', async () => {
    const expectations: Array<[unknown, string, string | null]> = [
      [false, 'open', null],
      [true, 'gated', 'unspecified'],
      ['auto', 'gated', 'auto'],
      ['manual', 'gated', 'manual'],
      ['nonsense', 'unknown', null],
    ]
    for (const [gated, state, mode] of expectations) {
      const { transport } = transportWith(async () => json([hubRow({ gated })]))
      const result = await transport.search({
        query: 'x', page: 1, pageSize: 10, cursor: null,
      })
      assert.equal(result.state, 'listed')
      assert.equal(result.repositories[0]!.gated.state, state, String(gated))
      assert.equal(result.repositories[0]!.gated.mode, mode, String(gated))
    }

    const { transport } = transportWith(async () =>
      json([hubRow({ tags: ['license:mit', 'license:apache-2.0'] })]))
    const conflicting = await transport.search({
      query: 'x', page: 1, pageSize: 10, cursor: null,
    })
    assert.equal(conflicting.state, 'listed')
    assert.equal(conflicting.repositories[0]!.license.state, 'unknown')
    assert.equal(conflicting.repositories[0]!.license.source, 'conflicting_declarations')
  })

  it('maps every transport failure to a typed redacted reason without leaking the body', async () => {
    const secret = 'SECRET-TOKEN-abc123 https://internal.example/endpoint'
    const cases: Array<[string, () => Promise<Response>, string]> = [
      [
        'unavailable',
        async () => { throw new Error(`connect ECONNREFUSED ${secret}`) },
        'provider_unavailable',
      ],
      [
        'malformed json',
        async () => new Response(`not json ${secret}`, {
          status: 200, headers: { 'content-type': 'application/json' },
        }),
        'provider_malformed',
      ],
      [
        'non-array search payload',
        async () => json({ error: secret }),
        'provider_malformed',
      ],
      ['rate limited', async () => json({ error: secret }, { status: 429 }), 'rate_limited'],
      ['not found', async () => json({ error: secret }, { status: 404 }), 'not_found'],
      ['forbidden reads as not found', async () => json({ error: secret }, { status: 403 }), 'not_found'],
      ['server error', async () => json({ error: secret }, { status: 503 }), 'provider_unavailable'],
      ['client error', async () => json({ error: secret }, { status: 400 }), 'provider_error'],
    ]

    for (const [label, handler, reason] of cases) {
      const { transport } = transportWith(handler)
      const result = await transport.search({
        query: 'x', page: 1, pageSize: 10, cursor: null,
      })
      assert.equal(result.state, 'failed', label)
      assert.equal(result.reason, reason, label)
      assert.equal(result.source.state, 'unavailable', label)
      assert.equal(result.source.reason, reason, label)
      assert.deepEqual(result.repositories, [], label)
      assert.equal(result.nextCursor, null, label)
      assert.deepEqual(huggingFaceSearchResultSchema.parse(result), result, label)

      // Nothing in the published result may echo the provider body, host or token.
      const serialized = JSON.stringify(result)
      assert.equal(serialized.includes('SECRET-TOKEN'), false, label)
      assert.equal(serialized.includes('internal.example'), false, label)
      assert.equal(serialized.includes('huggingface.co'), false, label)
      assert.equal(serialized.includes('/api/models'), false, label)
      assert.equal(serialized.includes('ECONNREFUSED'), false, label)
    }
  })

  it('refuses an oversized response instead of parsing a partial prefix', async () => {
    const oversized = JSON.stringify([hubRow()]) + ' '.repeat(4_096)
    const { transport } = transportWith(
      async () => new Response(oversized, {
        status: 200, headers: { 'content-type': 'application/json' },
      }),
      { maxResponseBytes: 64 },
    )
    const result = await transport.search({
      query: 'x', page: 1, pageSize: 10, cursor: null,
    })
    assert.equal(result.state, 'failed')
    assert.equal(result.reason, 'response_too_large')
    assert.deepEqual(result.repositories, [])
  })

  it('bounds a slow connect and a slow body with typed timeouts', async () => {
    const connect = transportWith(
      async (_url, init) => new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(new Error('aborted')))
      }),
      { connectTimeoutMs: 20 },
    )
    const connectResult = await connect.transport.search({
      query: 'x', page: 1, pageSize: 10, cursor: null,
    })
    assert.equal(connectResult.state, 'failed')
    assert.equal(connectResult.reason, 'connect_timeout')

    const stalled = transportWith(
      async (_url, init) => new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(new TextEncoder().encode('['))
            init?.signal?.addEventListener('abort', () => {
              try { controller.error(new Error('aborted')) } catch { /* already closed */ }
            })
          },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      ),
      { responseTimeoutMs: 20 },
    )
    const stalledResult = await stalled.transport.search({
      query: 'x', page: 1, pageSize: 10, cursor: null,
    })
    assert.equal(stalledResult.state, 'failed')
    assert.equal(stalledResult.reason, 'response_timeout')
  })

  it('stops its own wait and publishes nothing when the caller aborts', async () => {
    const controller = new AbortController()
    const { calls, transport } = transportWith(
      async (_url, init) => new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(
          new DOMException('Aborted', 'AbortError'),
        ))
        controller.abort('caller-cancelled')
      }),
    )
    await assert.rejects(
      () => transport.search({
        query: 'x', page: 1, pageSize: 10, cursor: null, signal: controller.signal,
      }),
    )
    assert.equal(calls.length, 1)

    // An already-aborted signal must not even open the request.
    const pre = new AbortController()
    pre.abort('already')
    const second = transportWith(async () => json([hubRow()]))
    await assert.rejects(
      () => second.transport.search({
        query: 'x', page: 1, pageSize: 10, cursor: null, signal: pre.signal,
      }),
    )
    assert.equal(second.calls.length, 0)
  })

  it('drops unidentifiable rows and reports the shrunken page', async () => {
    const { transport } = transportWith(async () => json([
      hubRow(),
      { id: 'no-owner' },
      { id: 'a/b/c' },
      { id: 42 },
      null,
      ['nope'],
      { nothing: true },
    ]))
    const result = await transport.search({
      query: 'x', page: 1, pageSize: 10, cursor: null,
    })
    assert.equal(result.state, 'listed')
    assert.equal(result.repositories.length, 1)
    // A shrunken page is visible rather than looking like a smaller result set.
    assert.equal(result.droppedRows, 6)
  })

  it('reports an all-dropped or empty page as empty, not as failed', async () => {
    for (const payload of [[], [{ id: 'no-owner' }]]) {
      const { transport } = transportWith(async () => json(payload))
      const result = await transport.search({
        query: 'x', page: 1, pageSize: 10, cursor: null,
      })
      assert.equal(result.state, 'empty')
      assert.equal(result.nextCursor, null)
      assert.equal(result.reason, null)
      assert.equal(result.source.state, 'available')
      assert.deepEqual(huggingFaceSearchResultSchema.parse(result), result)
    }
  })

  it('echoes only an opaque same-origin cursor and stops at the page bound', async () => {
    assert.equal(
      nextCursorFromLink('<https://huggingface.co/api/models?cursor=abc>; rel="next"'),
      'abc',
    )
    // A hostile or foreign Link header cannot redirect the next bounded read.
    for (const link of [
      '<https://evil.test/api/models?cursor=abc>; rel="next"',
      '<https://huggingface.co.evil.test/api/models?cursor=abc>; rel="next"',
      '<https://huggingface.co/api/models>; rel="next"',
      '<https://huggingface.co/api/models?cursor=>; rel="next"',
      '<https://huggingface.co/api/models?cursor=abc>; rel="prev"',
      'garbage',
      null,
    ]) {
      assert.equal(nextCursorFromLink(link), null, String(link))
    }

    const { transport } = transportWith(async () => json([hubRow()], {
      headers: {
        'content-type': 'application/json',
        link: '<https://huggingface.co/api/models?cursor=page2>; rel="next"',
      },
    }))
    const first = await transport.search({
      query: 'x', page: 1, pageSize: 10, cursor: null,
    })
    assert.equal(first.state, 'listed')
    assert.equal(first.nextCursor, 'page2')

    // The last page this slice will walk never advertises another cursor.
    const last = await transport.search({
      query: 'x', page: 5, pageSize: 10, cursor: 'page5',
    })
    assert.equal(last.state, 'listed')
    assert.equal(last.nextCursor, null)

    // Beyond the bound the transport refuses rather than walking further.
    const beyond = await transport.search({
      query: 'x', page: 6, pageSize: 10, cursor: 'page6',
    })
    assert.equal(beyond.state, 'failed')
  })

  it('forwards an opaque cursor verbatim without parsing or constructing it', async () => {
    const { calls, transport } = transportWith(async () => json([hubRow()]))
    await transport.search({
      query: 'x', page: 2, pageSize: 10, cursor: 'OPAQUE==cursor/value',
    })
    assert.equal(
      new URL(calls[0]!.url).searchParams.get('cursor'),
      'OPAQUE==cursor/value',
    )
  })

  it('returns an unknown-verdict row when a repository read fails', async () => {
    const { transport } = transportWith(async () => json({ error: 'x' }, { status: 503 }))
    const result = await transport.repository({ preview: preview() })
    assert.equal(result.state, 'failed')
    assert.equal(result.reason, 'provider_unavailable')
    assert.equal(result.repository.metadata, 'unavailable')
    // A failed read is not evidence that the repository lacks GGUF files.
    assert.equal(result.repository.verdict.state, 'unknown')
    assert.equal(result.repository.verdict.reason, 'metadata_unavailable')
    assert.equal(result.repository.files.state, 'unknown')
    assert.deepEqual(result.repository.files.ggufFiles, [])
    assert.equal(result.repository.identity.repositoryId, 'TheBloke/Llama-2-7B-GGUF')
    assert.deepEqual(huggingFaceRepositoryResultSchema.parse(result), result)
  })

  it('reads one repository by its exact parsed identity', async () => {
    const { calls, transport } = transportWith(async () => json(hubRow()))
    const result = await transport.repository({ preview: preview() })
    assert.equal(
      new URL(calls[0]!.url).pathname,
      '/api/models/TheBloke/Llama-2-7B-GGUF',
    )
    assert.equal(new URL(calls[0]!.url).searchParams.has('blobs'), false)
    assert.equal(result.state, 'resolved')
    assert.equal(result.repository.verdict.state, 'supported')
    assert.deepEqual(huggingFaceRepositoryResultSchema.parse(result), result)
  })

  it('P2-K reads an exact immutable revision with file metadata enabled for selection', async () => {
    const { calls, transport } = transportWith(async () => json(hubRow()))
    const result = await transport.repository({
      preview: preview(),
      revision: {
        state: 'exact_commit', commit: SHA, source: 'hugging_face_api_model',
      },
    })

    assert.equal(calls.length, 1)
    const url = new URL(calls[0]!.url)
    assert.equal(
      url.pathname,
      `/api/models/TheBloke/Llama-2-7B-GGUF/revision/${SHA}`,
    )
    assert.equal(url.searchParams.get('blobs'), 'true')
    assert.equal(url.searchParams.has('full'), false)
    const headers = new Headers(calls[0]!.init?.headers as Record<string, string>)
    assert.equal(headers.get('authorization'), null)
    assert.equal(calls[0]!.init?.redirect, 'error')
    assert.equal(result.state, 'resolved')
    assert.equal(result.repository.revision.state, 'exact_commit')
    assert.deepEqual(huggingFaceRepositoryResultSchema.parse(result), result)
  })

  it('refuses a payload describing a different repository than the one requested', async () => {
    const { transport } = transportWith(async () => json(hubRow({ id: 'other/repo' })))
    const result = await transport.repository({ preview: preview() })
    // A mismatched payload cannot be published as this repository's facts.
    assert.equal(result.state, 'failed')
    assert.equal(result.reason, 'provider_malformed')
    assert.equal(result.repository.metadata, 'unavailable')
    assert.equal(result.repository.identity.repositoryId, 'TheBloke/Llama-2-7B-GGUF')
  })

  it('decides the verdict only from exact GGUF evidence', () => {
    assert.equal(decideVerdict({
      state: 'listed', source: 'hugging_face_api_model', totalFiles: 1,
      malformedEntries: 0, truncated: false,
      ggufFiles: [{ path: 'a.gguf', sizeBytes: 1, sizeSource: 'hugging_face_api_model' }],
    }).state, 'supported')
    assert.equal(decideVerdict({
      state: 'listed', source: 'hugging_face_api_model', totalFiles: 1,
      malformedEntries: 0, truncated: false, ggufFiles: [],
    }).state, 'unsupported')
    assert.equal(decideVerdict({
      state: 'listed', source: 'hugging_face_api_model', totalFiles: 1,
      malformedEntries: 0, truncated: true, ggufFiles: [],
    }).state, 'unknown')
    assert.equal(decideVerdict({
      state: 'listed', source: 'hugging_face_api_model', totalFiles: 1,
      malformedEntries: 1, truncated: false, ggufFiles: [],
    }).state, 'unknown')
    assert.equal(decideVerdict({
      state: 'unknown', source: 'metadata_unavailable', totalFiles: null,
      malformedEntries: null, truncated: null, ggufFiles: [],
    }).state, 'unknown')
    // Every verdict in this slice still demands the P2-K exact file choice.
    for (const truncated of [true, false]) {
      assert.equal(decideVerdict({
        state: 'listed', source: 'hugging_face_api_model', totalFiles: 0,
        malformedEntries: 0, truncated, ggufFiles: [],
      }).requiresExactFileSelection, true)
    }
  })

  it('counts only an exact .gguf suffix as GGUF evidence', async () => {
    // A name that merely mentions gguf is not a GGUF file, so it can neither create
    // `supported` nor be listed as a selectable P2-K target.
    const notGguf = [
      { rfilename: 'gguf-conversion-notes.txt', size: 1 },
      { rfilename: 'README-gguf.md', size: 1 },
      { rfilename: 'gguf', size: 1 },
      { rfilename: 'model.gguf.safetensors', size: 1 },
      { rfilename: 'ggufdir/model.bin', size: 1 },
    ]
    const { transport } = transportWith(async () => json([hubRow({ siblings: notGguf })]))
    const result = await transport.search({
      query: 'x', page: 1, pageSize: 10, cursor: null,
    })
    assert.equal(result.state, 'listed')
    const repository = result.repositories[0]!
    assert.deepEqual(repository.files.ggufFiles, [])
    assert.equal(repository.verdict.state, 'unsupported')
    assert.equal(repository.verdict.basis, 'complete_listing_without_gguf')

    // The suffix is matched case-insensitively, but only as a real suffix.
    const { transport: upper } = transportWith(async () => json([hubRow({
      siblings: [{ rfilename: 'Model.GGUF', size: 1 }],
    })]))
    const upperResult = await upper.search({
      query: 'x', page: 1, pageSize: 10, cursor: null,
    })
    assert.equal(upperResult.state, 'listed')
    assert.deepEqual(
      upperResult.repositories[0]!.files.ggufFiles.map((file) => file.path),
      ['Model.GGUF'],
    )
  })

  it('marks the source unavailable when a repository read fails', async () => {
    // `metadata: 'unavailable'` alone is not enough: the source health must also say
    // the Hub could not be read, or the UI would render a failure as a healthy answer.
    const { transport } = transportWith(async () => json({ error: 'x' }, { status: 429 }))
    const result = await transport.repository({ preview: preview() })
    assert.equal(result.state, 'failed')
    assert.equal(result.source.state, 'unavailable')
    assert.equal(result.source.reason, 'rate_limited')
    assert.equal(result.source.observedAt, OBSERVED_AT)
    assert.deepEqual(huggingFaceRepositoryResultSchema.parse(result), result)
  })

  it('records a reported gguf size only together with its source', async () => {
    const { transport } = transportWith(async () => json([hubRow({ siblings: [
      { rfilename: 'sized.gguf', size: 100 },
      { rfilename: 'unsized.gguf' },
      { rfilename: 'negative.gguf', size: -1 },
      { rfilename: 'fractional.gguf', size: 1.5 },
    ] })]))
    const result = await transport.search({
      query: 'x', page: 1, pageSize: 10, cursor: null,
    })
    assert.equal(result.state, 'listed')
    const files = result.repositories[0]!.files
    assert.equal(files.state, 'listed')
    const byPath = new Map(files.ggufFiles.map((file) => [file.path, file]))
    assert.deepEqual(byPath.get('sized.gguf'), {
      path: 'sized.gguf', sizeBytes: 100, sizeSource: 'hugging_face_api_model',
    })
    for (const path of ['unsized.gguf', 'negative.gguf', 'fractional.gguf']) {
      assert.deepEqual(byPath.get(path), {
        path, sizeBytes: null, sizeSource: 'not_reported',
      }, path)
    }
  })

  it('keeps a page beyond the bound representable in the contract', async () => {
    // A direct caller asking past the bound must still get a contract-valid refusal,
    // not an object whose own page number the schema rejects.
    const { transport, calls } = transportWith(async () => json([hubRow()]))
    const beyond = await transport.search({
      query: 'x', page: 9, pageSize: 999, cursor: 'c',
    })
    assert.equal(beyond.state, 'failed')
    assert.deepEqual(huggingFaceSearchResultSchema.parse(beyond), beyond)
    // Refused before the bound is crossed: no outbound read happened.
    assert.equal(calls.length, 0)
  })

  it('bounds the published rows by pageSize and reports the surplus as dropped', async () => {
    // `limit` is only a request hint, so a provider may answer with far more rows.
    const rows = Array.from({ length: 40 }, (_unused, index) => hubRow({
      id: `owner${index}/model-gguf`,
    }))
    const { transport } = transportWith(async () => json(rows))
    const result = await transport.search({
      query: 'x', page: 1, pageSize: 10, cursor: null,
    })
    assert.equal(result.state, 'listed')
    assert.equal(result.repositories.length, 10)
    assert.equal(result.droppedRows, 30)
    assert.deepEqual(huggingFaceSearchResultSchema.parse(result), result)
  })

  it('refuses a provider row whose owner is a reserved Hub route', async () => {
    // The transport must not admit an identity the strict local parser would refuse.
    const { transport } = transportWith(async () => json([
      hubRow({ id: 'datasets/squad' }),
      hubRow({ id: 'settings/tokens' }),
      hubRow({ id: 'spaces/demo' }),
      hubRow(),
    ]))
    const result = await transport.search({
      query: 'x', page: 1, pageSize: 10, cursor: null,
    })
    assert.equal(result.state, 'listed')
    assert.deepEqual(
      result.repositories.map((repository) => repository.identity.repositoryId),
      ['TheBloke/Llama-2-7B-GGUF'],
    )
    assert.equal(result.droppedRows, 3)
  })

  it('matches rel="next" as a whole token and refuses an unsafe cursor', async () => {
    // A substring match would accept an unrelated relation as pagination.
    assert.equal(
      nextCursorFromLink('<https://huggingface.co/api/models?cursor=abc>; rel="next-page"'),
      null,
    )
    assert.equal(
      nextCursorFromLink('<https://huggingface.co/api/models?cursor=abc>; rel="nextfoo"'),
      null,
    )
    // A whole-token match still works with extra attributes in any order.
    assert.equal(
      nextCursorFromLink('<https://huggingface.co/api/models?cursor=abc>; type="x"; rel="next"'),
      'abc',
    )
    assert.equal(
      nextCursorFromLink('<https://huggingface.co/api/models?cursor=abc>; rel=next'),
      'abc',
    )
    // A cursor carrying control characters or whitespace is refused outright rather
    // than relying on re-encoding wherever it is later used.
    for (const encoded of ['a%0D%0Ab', 'a%00b', 'a%20b', 'a%09b']) {
      assert.equal(
        nextCursorFromLink(
          `<https://huggingface.co/api/models?cursor=${encoded}>; rel="next"`,
        ),
        null,
        encoded,
      )
    }
  })

  it('reaches no Ollama, Governor, probe, catalog or Job surface', async () => {
    const { calls, transport } = transportWith(async () => json([hubRow()]))
    await transport.search({ query: 'x', page: 1, pageSize: 10, cursor: null })
    await transport.repository({ preview: preview() })
    // The only outbound edges are the two documented bounded Hub reads.
    assert.equal(calls.length, 2)
    for (const call of calls) {
      const url = new URL(call.url)
      assert.equal(url.origin, 'https://huggingface.co')
      assert.equal(call.init?.method, 'GET')
      // No pull/create/probe/load/unload verb may appear on this boundary.
      for (const forbidden of ['/api/pull', '/api/create', '/api/generate', '/api/chat', '/api/ps', '11434']) {
        assert.equal(call.url.includes(forbidden), false, `${call.url} ${forbidden}`)
      }
    }
  })
})
