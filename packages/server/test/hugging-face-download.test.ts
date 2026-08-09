import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtemp, readdir, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, it } from 'node:test'
import {
  huggingFaceDownloadStreamEventSchema,
  type HuggingFaceDownloadStreamEvent,
  type HuggingFaceSelectionResult,
} from '@alamo/contract'
import {
  exactHuggingFaceDownloadUrl,
  HUGGING_FACE_DOWNLOAD_ALLOWED_HOSTS,
  HuggingFaceDownloadService,
} from '../src/models/hugging-face-download.ts'

const roots: string[] = []
const SHA = 'a'.repeat(40)
const OBSERVED_AT = '2026-08-09T12:00:00.000Z'

async function root(): Promise<string> {
  const value = await mkdtemp(join(tmpdir(), 'alamo-hf-download-'))
  roots.push(value)
  return value
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((value) => rm(value, { recursive: true, force: true })))
})

function gguf(version: 2 | 3 = 3, payload = 'fixture'): Uint8Array {
  const bytes = new Uint8Array(8 + payload.length)
  bytes.set([0x47, 0x47, 0x55, 0x46])
  new DataView(bytes.buffer).setUint32(4, version, true)
  bytes.set(new TextEncoder().encode(payload), 8)
  return bytes
}

function confirmed(
  bytes: Uint8Array,
  options: { size?: number | null; digest?: string | null; gated?: boolean; path?: string } = {},
): Extract<HuggingFaceSelectionResult, { state: 'confirmed' }> {
  const path = options.path ?? 'quant/model Q4_K_M.gguf'
  const size = options.size === undefined ? bytes.byteLength : options.size
  const digest = options.digest === undefined
    ? createHash('sha256').update(bytes).digest('hex')
    : options.digest
  const identity = {
    provider: 'hugging_face' as const,
    owner: 'Owner', name: 'Model', repositoryId: 'Owner/Model', comparisonKey: 'owner/model',
  }
  const file = {
    path,
    sizeBytes: size,
    sizeSource: size === null ? 'not_reported' as const : 'hugging_face_api_model' as const,
    sha256: digest,
    sha256Source: digest === null ? 'not_reported' as const : 'hugging_face_lfs_oid' as const,
  }
  const repository = {
    version: 1 as const, provider: 'hugging_face' as const, identity,
    metadata: 'resolved' as const, observedAt: OBSERVED_AT,
    revision: { state: 'exact_commit' as const, commit: SHA, source: 'hugging_face_api_model' as const },
    gated: options.gated
      ? { state: 'gated' as const, mode: 'manual' as const }
      : { state: 'open' as const, mode: null },
    license: {
      state: 'declared' as const, value: 'apache-2.0',
      source: 'hugging_face_model_tags' as const, confidence: 'declared' as const,
    },
    files: {
      state: 'listed' as const, source: 'hugging_face_api_model' as const,
      totalFiles: 1, malformedEntries: 0, truncated: false, ggufFiles: [file],
    },
    verdict: {
      state: 'supported' as const, scope: 'exact_gguf_file_only' as const,
      basis: 'exact_gguf_files_listed' as const, reason: null,
      requiresExactFileSelection: true as const,
    },
  }
  return {
    state: 'confirmed', version: 1, repository,
    selection: {
      identity, revision: repository.revision, filePath: path,
      sizeBytes: size,
      sizeSource: size === null ? 'not_reported' : 'hugging_face_api_model',
    },
    fit: {
      state: 'unknown', contextLength: 8_192,
      basis: 'hardware_capacity_unavailable', verdict: null,
      reason: 'hardware_capacity_unavailable',
    },
    reason: null,
  }
}

function response(bytes: Uint8Array, headers: Record<string, string> = {}): Response {
  return new Response(bytes, { status: 200, headers })
}

async function collect(
  service: HuggingFaceDownloadService,
  selection: Extract<HuggingFaceSelectionResult, { state: 'confirmed' }>,
  signal = new AbortController().signal,
): Promise<HuggingFaceDownloadStreamEvent[]> {
  const events: HuggingFaceDownloadStreamEvent[] = []
  for await (const event of service.download(selection, signal)) {
    assert.deepEqual(huggingFaceDownloadStreamEventSchema.parse(event), event)
    events.push(event)
  }
  return events
}

function terminal(events: HuggingFaceDownloadStreamEvent[]) {
  return events.at(-1)!
}

describe('bounded cancel-safe exact Hugging Face GGUF download', () => {
  it('does not discard a foreign replacement at a formerly owned artifact path', async () => {
    const bytes = gguf()
    const rootDir = await root()
    const service = new HuggingFaceDownloadService({
      rootDir,
      fetch: (async () => response(bytes)) as typeof fetch,
      randomId: (() => {
        const ids = [
          '11111111-1111-4111-8111-111111111111',
          '22222222-2222-4222-8222-222222222222',
        ]
        return () => ids.shift()!
      })(),
    })
    const events = await collect(service, confirmed(bytes))
    assert.equal(terminal(events).type, 'completed')
    const artifact = service.artifact('11111111-1111-4111-8111-111111111111')!
    await rm(artifact.path)
    const foreign = Buffer.from('foreign replacement')
    await writeFile(artifact.path, foreign)

    assert.equal(await service.discard(artifact.id), false)
    assert.deepEqual(await readFile(artifact.path), foreign)
    assert.notEqual(service.artifact(artifact.id), null)
  })

  it('encodes owner/name and every file segment independently', () => {
    const selection = confirmed(gguf(), { path: 'folder/100% café/model name.gguf' })
    selection.selection.identity.owner = 'Ow ner'
    selection.selection.identity.name = '模型%name'
    const url = exactHuggingFaceDownloadUrl(selection)
    assert.equal(
      url.pathname,
      `/Ow%20ner/%E6%A8%A1%E5%9E%8B%25name/resolve/${SHA}/folder/100%25%20caf%C3%A9/model%20name.gguf`,
    )
    assert.equal(url.pathname.includes('%252F'), false)
  })

  it('follows only an explicit official HTTPS redirect without forwarding credentials', async () => {
    const bytes = gguf()
    const calls: Array<{ url: string; init?: RequestInit }> = []
    const service = new HuggingFaceDownloadService({
      rootDir: await root(),
      fetch: (async (input: unknown, init?: RequestInit) => {
        calls.push({ url: String(input), init })
        if (calls.length === 1) {
          return new Response(null, {
            status: 302,
            headers: { location: 'https://cdn-lfs-us-1.hf.co/signed-object' },
          })
        }
        return response(bytes, { 'content-length': String(bytes.byteLength) })
      }) as typeof fetch,
      now: () => new Date(OBSERVED_AT),
    })
    const events = await collect(service, confirmed(bytes))
    assert.equal(terminal(events).type, 'completed')
    assert.equal(calls.length, 2)
    for (const call of calls) {
      const headers = new Headers(call.init?.headers)
      assert.equal(call.init?.redirect, 'manual')
      assert.equal(headers.get('authorization'), null)
      assert.equal(headers.get('cookie'), null)
      assert.equal(headers.get('range'), null)
      assert.equal(headers.get('last-event-id'), null)
    }
  })

  it('allows every documented host on default HTTPS and refuses non-default ports', async () => {
    const bytes = gguf()
    for (const host of HUGGING_FACE_DOWNLOAD_ALLOWED_HOSTS) {
      let calls = 0
      const service = new HuggingFaceDownloadService({
        rootDir: await root(),
        fetch: (async () => {
          calls += 1
          return calls === 1
            ? new Response(null, {
                status: 302,
                headers: { location: `https://${host}:443/object` },
              })
            : response(bytes)
        }) as typeof fetch,
      })
      assert.equal(terminal(await collect(service, confirmed(bytes))).type, 'completed', host)
      assert.equal(calls, 2, host)

      for (const port of ['444', '8443']) {
        calls = 0
        const refused = new HuggingFaceDownloadService({
          rootDir: await root(),
          fetch: (async () => {
            calls += 1
            return new Response(null, {
              status: 302,
              headers: { location: `https://${host}:${port}/object` },
            })
          }) as typeof fetch,
        })
        const end = terminal(await collect(refused, confirmed(bytes)))
        assert.equal(end.type, 'refused', `${host}:${port}`)
        if (end.type === 'refused') assert.equal(end.data.reason, 'redirect_not_allowed')
        assert.equal(calls, 1)
      }
    }
  })

  it('refuses hostile, downgrade, suffix-lookalike and redirect-loop targets', async () => {
    const bytes = gguf()
    const locations = [
      'https://evil.example/file',
      'http://cdn-lfs-us-1.hf.co/file',
      'https://cdn-lfs-us-1.hf.co.evil.example/file',
    ]
    for (const location of locations) {
      const service = new HuggingFaceDownloadService({
        rootDir: await root(),
        fetch: (async () => new Response(null, { status: 302, headers: { location } })) as typeof fetch,
      })
      const end = terminal(await collect(service, confirmed(bytes)))
      assert.equal(end.type, 'refused', location)
      if (end.type === 'refused') assert.equal(end.data.reason, 'redirect_not_allowed', location)
    }
    const loop = new HuggingFaceDownloadService({
      rootDir: await root(), maxRedirects: 1,
      fetch: (async () => new Response(null, {
        status: 302, headers: { location: 'https://huggingface.co/loop' },
      })) as typeof fetch,
    })
    const end = terminal(await collect(loop, confirmed(bytes)))
    assert.equal(end.type, 'refused')
    if (end.type === 'refused') assert.equal(end.data.reason, 'redirect_limit_exceeded')
  })

  it('publishes known or unknown total only from observed facts', async () => {
    const bytes = gguf()
    for (const known of [true, false]) {
      const service = new HuggingFaceDownloadService({
        rootDir: await root(),
        fetch: (async () => response(bytes, known ? { 'content-length': String(bytes.byteLength) } : {})) as typeof fetch,
      })
      const selection = confirmed(bytes, { size: known ? bytes.byteLength : null, digest: null })
      const events = await collect(service, selection)
      const progress = events.find((event) => event.type === 'progress')
      assert.equal(progress?.type, 'progress')
      if (progress?.type === 'progress') {
        assert.equal(progress.data.totalBytes, known ? bytes.byteLength : null)
      }
      const end = terminal(events)
      assert.equal(end.type, 'completed')
      if (end.type === 'completed') {
        assert.equal(end.data.provenance.checksum.relation, 'locally_observed_only')
      }
    }
  })

  it('fails closed for malformed length, mismatched size and over-limit streams', async () => {
    const bytes = gguf()
    const cases: Array<[string, HuggingFaceDownloadService, ReturnType<typeof confirmed>, string]> = [
      ['bad length', new HuggingFaceDownloadService({
        rootDir: await root(), fetch: (async () => response(bytes, { 'content-length': 'nope' })) as typeof fetch,
      }), confirmed(bytes), 'content_length_invalid'],
      ['length mismatch', new HuggingFaceDownloadService({
        rootDir: await root(), fetch: (async () => response(bytes, { 'content-length': String(bytes.byteLength) })) as typeof fetch,
      }), confirmed(bytes, { size: bytes.byteLength + 1 }), 'size_mismatch'],
      ['over limit', new HuggingFaceDownloadService({
        rootDir: await root(), maxBytes: 8,
        fetch: (async () => response(bytes)) as typeof fetch,
      }), confirmed(bytes, { size: null }), 'maximum_bytes_exceeded'],
    ]
    for (const [label, service, selection, reason] of cases) {
      const end = terminal(await collect(service, selection))
      assert.equal(end.type, 'failed', label)
      if (end.type === 'failed') assert.equal(end.data.reason, reason, label)
    }
  })

  it('bounds connect wait and rejects an oversized declared response before reading it', async () => {
    const stalledRoot = await root()
    const stalled = new HuggingFaceDownloadService({
      rootDir: stalledRoot, connectTimeoutMs: 5,
      fetch: ((_input: unknown, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(init.signal?.reason), { once: true })
      })) as typeof fetch,
    })
    const timeout = terminal(await collect(stalled, confirmed(gguf())))
    assert.equal(timeout.type, 'failed')
    if (timeout.type === 'failed') assert.equal(timeout.data.reason, 'connect_timeout')
    assert.deepEqual(await readdir(stalledRoot), [])

    const oversizedRoot = await root()
    const stream = new ReadableStream<Uint8Array>({})
    const oversized = new HuggingFaceDownloadService({
      rootDir: oversizedRoot, maxBytes: 8,
      fetch: (async () => new Response(stream, {
        status: 200, headers: { 'content-length': '9' },
      })) as typeof fetch,
    })
    const tooLarge = terminal(await collect(
      oversized, confirmed(gguf(), { size: null, digest: null }),
    ))
    assert.equal(tooLarge.type, 'failed')
    if (tooLarge.type === 'failed') assert.equal(tooLarge.data.reason, 'maximum_bytes_exceeded')
    assert.deepEqual(await readdir(oversizedRoot), [])
  })

  it('never emits progress beyond a declared Content-Length', async () => {
    const bytes = gguf()
    const service = new HuggingFaceDownloadService({
      rootDir: await root(),
      fetch: (async () => response(bytes, { 'content-length': '1' })) as typeof fetch,
    })
    const events = await collect(service, confirmed(bytes, { size: null, digest: null }))
    assert.equal(events.some((current) => current.type === 'progress'), false)
    const end = terminal(events)
    assert.equal(end.type, 'failed')
    if (end.type === 'failed') assert.equal(end.data.reason, 'size_mismatch')
  })

  it('accepts only a complete HTTP 200 response and never commits partial 2xx bodies', async () => {
    const bytes = gguf()
    for (const status of [201, 202, 203, 206]) {
      const staging = await root()
      const service = new HuggingFaceDownloadService({
        rootDir: staging,
        fetch: (async () => new Response(bytes, {
          status,
          headers: status === 206 ? { 'content-range': `bytes 0-${bytes.byteLength - 1}/100` } : {},
        })) as typeof fetch,
      })
      const events = await collect(service, confirmed(bytes, { size: null, digest: null }))
      assert.equal(events.some((current) => current.type === 'completed'), false, String(status))
      const end = terminal(events)
      assert.equal(end.type, 'failed', String(status))
      if (end.type === 'failed') assert.equal(end.data.reason, 'provider_error')
      assert.deepEqual(await readdir(staging), [])
    }
  })

  it('distinguishes provider SHA-256 match, mismatch and observed-only digest', async () => {
    const bytes = gguf()
    const digest = createHash('sha256').update(bytes).digest('hex')
    for (const expected of [digest, 'b'.repeat(64), null]) {
      const service = new HuggingFaceDownloadService({
        rootDir: await root(), fetch: (async () => response(bytes)) as typeof fetch,
      })
      const end = terminal(await collect(service, confirmed(bytes, { digest: expected })))
      if (expected === 'b'.repeat(64)) {
        assert.equal(end.type, 'failed')
        if (end.type === 'failed') assert.equal(end.data.reason, 'checksum_mismatch')
      } else {
        assert.equal(end.type, 'completed')
        if (end.type === 'completed') {
          assert.equal(end.data.provenance.checksum.observedDigest, digest)
          assert.equal(
            end.data.provenance.checksum.relation,
            expected === null ? 'locally_observed_only' : 'matched_provider_claim',
          )
        }
      }
    }
  })

  it('rejects truncated, bad-magic and unsupported-version GGUF headers', async () => {
    const invalid = [
      [new Uint8Array([0x47, 0x47]), 'invalid_gguf_header'],
      [new TextEncoder().encode('NOTGGUF!'), 'invalid_gguf_magic'],
      [(() => {
        const value = gguf()
        new DataView(value.buffer).setUint32(4, 99, true)
        return value
      })(), 'unsupported_gguf_version'],
    ] as const
    for (const [bytes, reason] of invalid) {
      const service = new HuggingFaceDownloadService({
        rootDir: await root(), fetch: (async () => response(bytes)) as typeof fetch,
      })
      const end = terminal(await collect(service, confirmed(bytes)))
      assert.equal(end.type, 'failed')
      if (end.type === 'failed') assert.equal(end.data.reason, reason)
    }
  })

  it('accepts the supported GGUF v2 header and records the observed version', async () => {
    const bytes = gguf(2)
    const service = new HuggingFaceDownloadService({
      rootDir: await root(), fetch: (async () => response(bytes)) as typeof fetch,
    })
    const end = terminal(await collect(service, confirmed(bytes)))
    assert.equal(end.type, 'completed')
    if (end.type === 'completed') assert.equal(end.data.provenance.format.version, 2)
  })

  it('times out a stalled body and deletes its owned partial file', async () => {
    const first = gguf().subarray(0, 4)
    const stream = new ReadableStream<Uint8Array>({
      start(controller) { controller.enqueue(first) },
      pull() { return new Promise(() => {}) },
    })
    const staging = await root()
    const service = new HuggingFaceDownloadService({
      rootDir: staging, bodyTimeoutMs: 5,
      fetch: (async () => new Response(stream)) as typeof fetch,
    })
    const end = terminal(await collect(service, confirmed(gguf(), { size: null, digest: null })))
    assert.equal(end.type, 'failed')
    if (end.type === 'failed') assert.equal(end.data.reason, 'body_timeout')
    assert.deepEqual(await readdir(staging), [])
  })

  it('cancels during the body and verification and deletes only partial data', async () => {
    const bytes = gguf()
    for (const cancelAt of ['body', 'verifying'] as const) {
      const staging = await root()
      const service = new HuggingFaceDownloadService({
        rootDir: staging,
        fetch: (async () => response(bytes)) as typeof fetch,
      })
      const controller = new AbortController()
      const iterator = service.download(confirmed(bytes), controller.signal)
      let next = await iterator.next() // preparing
      assert.equal(next.value?.type, 'state')
      next = await iterator.next() // progress
      assert.equal(next.value?.type, 'progress')
      if (cancelAt === 'verifying') {
        next = await iterator.next()
        assert.equal(next.value?.type, 'state')
        if (next.value?.type === 'state') assert.equal(next.value.data.state, 'verifying')
      }
      controller.abort('hf-download-user-cancelled')
      next = await iterator.next()
      assert.equal(next.value?.type, 'cancelled')
      await iterator.return(undefined)
      assert.deepEqual(await readdir(staging), [])
    }
  })

  it('cancels while waiting for a redirect response and removes the owned partial', async () => {
    const staging = await root()
    let fetchSignal: AbortSignal | null = null
    const service = new HuggingFaceDownloadService({
      rootDir: staging,
      fetch: ((_input: unknown, init?: RequestInit) => {
        fetchSignal = init?.signal ?? null
        return new Promise<Response>((_resolve, reject) => {
          fetchSignal?.addEventListener('abort', () => reject(fetchSignal?.reason), { once: true })
        })
      }) as typeof fetch,
    })
    const controller = new AbortController()
    const iterator = service.download(confirmed(gguf()), controller.signal)
    assert.equal((await iterator.next()).value?.type, 'state')
    const waiting = iterator.next()
    while (fetchSignal === null) {
      await new Promise<void>((resolveWait) => setImmediate(resolveWait))
    }
    controller.abort('hf-download-user-cancelled')
    const cancelled = await waiting
    assert.equal(cancelled.value?.type, 'cancelled')
    assert.equal((fetchSignal as AbortSignal).aborted, true)
    await iterator.return(undefined)
    assert.deepEqual(await readdir(staging), [])
  })

  it('collapses a duplicate active exact target to one writer', async () => {
    let release!: () => void
    const gate = new Promise<void>((resolveGate) => { release = resolveGate })
    const bytes = gguf()
    const service = new HuggingFaceDownloadService({
      rootDir: await root(),
      fetch: (async () => {
        await gate
        return response(bytes)
      }) as typeof fetch,
    })
    const selection = confirmed(bytes)
    const firstController = new AbortController()
    const first = service.download(selection, firstController.signal)
    await first.next()
    const blocked = first.next()
    await Promise.resolve()
    const duplicate = await collect(service, selection)
    const end = terminal(duplicate)
    assert.equal(end.type, 'refused')
    if (end.type === 'refused') assert.equal(end.data.reason, 'duplicate_active')
    firstController.abort('hf-download-user-cancelled')
    release()
    await blocked
    await first.return(undefined)
  })

  it('uses generated no-overwrite names, rejects symlink collisions and atomically commits success', async () => {
    const bytes = gguf()
    const staging = await root()
    const artifact = '11111111-1111-4111-8111-111111111111'
    const partial = '22222222-2222-4222-8222-222222222222'
    await symlink('/does/not/exist', join(staging, `${artifact}.gguf`))
    const ids = [artifact, partial]
    const service = new HuggingFaceDownloadService({
      rootDir: staging,
      randomId: () => ids.shift()!,
      fetch: (async () => response(bytes)) as typeof fetch,
    })
    const end = terminal(await collect(service, confirmed(bytes)))
    assert.equal(end.type, 'failed')
    if (end.type === 'failed') assert.equal(end.data.reason, 'filesystem_error')
    assert.deepEqual(await readdir(staging), [`${artifact}.gguf`])

    const successRoot = await root()
    const success = new HuggingFaceDownloadService({
      rootDir: successRoot, fetch: (async () => response(bytes)) as typeof fetch,
    })
    const completed = terminal(await collect(success, confirmed(bytes)))
    assert.equal(completed.type, 'completed')
    if (completed.type === 'completed') {
      const names = await readdir(successRoot)
      assert.deepEqual(names, [`${completed.data.provenance.artifact.id}.gguf`])
      assert.deepEqual(await readFile(join(successRoot, names[0]!)), Buffer.from(bytes))
      assert.equal(names.some((name) => name.endsWith('.partial')), false)
    }
  })

  it('never deletes a foreign regular file or symlink on a partial-name collision', async () => {
    const bytes = gguf()
    for (const kind of ['file', 'symlink'] as const) {
      const staging = await root()
      const artifact = kind === 'file'
        ? '33333333-3333-4333-8333-333333333333'
        : '55555555-5555-4555-8555-555555555555'
      const partial = kind === 'file'
        ? '44444444-4444-4444-8444-444444444444'
        : '66666666-6666-4666-8666-666666666666'
      const foreign = join(staging, 'foreign.txt')
      const partialPath = join(staging, `.${partial}.partial`)
      await writeFile(foreign, 'FOREIGN-DATA')
      if (kind === 'file') await writeFile(partialPath, 'SENTINEL')
      else await symlink(foreign, partialPath)
      let fetchCalls = 0
      const ids = [artifact, partial]
      const service = new HuggingFaceDownloadService({
        rootDir: staging,
        randomId: () => ids.shift()!,
        fetch: (async () => { fetchCalls += 1; return response(bytes) }) as typeof fetch,
      })
      const end = terminal(await collect(service, confirmed(bytes)))
      assert.equal(end.type, 'failed')
      if (end.type === 'failed') assert.equal(end.data.reason, 'filesystem_error')
      assert.equal(fetchCalls, 0)
      assert.equal(await readFile(foreign, 'utf8'), 'FOREIGN-DATA')
      assert.equal(await readFile(partialPath, 'utf8'), kind === 'file' ? 'SENTINEL' : 'FOREIGN-DATA')
    }
  })

  it('refuses a managed-root symlink without touching its target', async () => {
    const parent = await root()
    const target = await root()
    const staging = join(parent, 'staging')
    await symlink(target, staging)
    await writeFile(join(target, 'foreign.txt'), 'keep')
    const bytes = gguf()
    const service = new HuggingFaceDownloadService({
      rootDir: staging, fetch: (async () => response(bytes)) as typeof fetch,
    })
    const end = terminal(await collect(service, confirmed(bytes)))
    assert.equal(end.type, 'failed')
    assert.deepEqual(await readdir(target), ['foreign.txt'])
  })

  it('refuses gated targets before fetch or filesystem side effects', async () => {
    let fetchCalls = 0
    const staging = join(await root(), 'not-created')
    const bytes = gguf()
    const service = new HuggingFaceDownloadService({
      rootDir: staging,
      fetch: (async () => { fetchCalls += 1; return response(bytes) }) as typeof fetch,
    })
    const end = terminal(await collect(service, confirmed(bytes, { gated: true })))
    assert.equal(end.type, 'refused')
    if (end.type === 'refused') assert.equal(end.data.reason, 'gated_repository')
    assert.equal(fetchCalls, 0)
  })
})
