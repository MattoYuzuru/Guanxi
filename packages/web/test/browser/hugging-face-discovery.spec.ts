import { expect, test } from '@playwright/test'
import { browserSettings, runtimeBrowserSnapshot } from './fixtures/runtime-snapshot.ts'

test('Marketplace discovers Hugging Face repositories read-only without resource side effects', async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 })
  await page.emulateMedia({ reducedMotion: 'reduce' })
  const observedAt = '2026-08-07T12:00:00.000Z'
  const requests: Array<{ path: string; method: string; body: string | null }> = []
  const pageErrors: string[] = []
  page.on('pageerror', (error) => pageErrors.push(error.message))

  const health = {
    ok: true, appVersion: 'test',
    application: { state: 'reachable', source: 'application_http', observedAt },
    ollama: {
      installed: true, installSource: 'runtime_response', running: true,
      state: 'reachable', source: 'ollama_api_version', observedAt,
      version: '0.12.6', host: 'http://127.0.0.1:11434', installHint: null,
    },
    hardware: {
      platform: 'darwin', arch: 'arm64', cpuModel: 'fixture', cpuCores: 8,
      totalMemoryBytes: 16_000_000_000, usableMemoryBytes: 12_000_000_000,
      accelerator: 'metal', acceleratorName: 'Fixture Metal', unifiedMemory: true,
      freeDiskBytes: null,
    },
    network: {
      ollamaComReachable: null, checkedAt: null,
      status: 'unknown', source: 'not_checked',
    },
  }

  const identity = (owner: string, name: string) => ({
    provider: 'hugging_face', owner, name,
    repositoryId: `${owner}/${name}`,
    comparisonKey: `${owner}/${name}`.toLowerCase(),
  })

  const supported = {
    version: 1, provider: 'hugging_face',
    identity: identity('TheBloke', 'Llama-2-7B-GGUF'),
    metadata: 'resolved', observedAt,
    revision: { state: 'exact_commit', commit: 'a'.repeat(40), source: 'hugging_face_api_model' },
    gated: { state: 'gated', mode: 'manual' },
    license: {
      state: 'declared', value: 'apache-2.0',
      source: 'hugging_face_model_tags', confidence: 'declared',
    },
    files: {
      state: 'listed', source: 'hugging_face_api_model', totalFiles: 2,
      malformedEntries: 0, truncated: false,
      ggufFiles: [{
        path: 'llama-2-7b.Q4_K_M.gguf', sizeBytes: 4_000_000_000,
        sizeSource: 'hugging_face_api_model',
      }],
    },
    verdict: {
      state: 'supported', scope: 'exact_gguf_file_only',
      basis: 'exact_gguf_files_listed', reason: null,
      requiresExactFileSelection: true,
    },
  }

  const unsupported = {
    ...supported,
    identity: identity('openai', 'whisper-large-v3'),
    gated: { state: 'open', mode: null },
    files: {
      state: 'listed', source: 'hugging_face_api_model', totalFiles: 3,
      malformedEntries: 0, truncated: false, ggufFiles: [],
    },
    verdict: {
      state: 'unsupported', scope: 'exact_gguf_file_only',
      basis: 'complete_listing_without_gguf', reason: null,
      requiresExactFileSelection: true,
    },
  }

  const unknown = {
    ...supported,
    identity: identity('mystery', 'repo'),
    metadata: 'unavailable',
    revision: { state: 'unknown', commit: null, source: 'not_reported' },
    gated: { state: 'unknown', mode: null },
    license: {
      state: 'unknown', value: null,
      source: 'metadata_unavailable', confidence: 'unknown',
    },
    files: {
      state: 'unknown', source: 'metadata_unavailable', totalFiles: null,
      malformedEntries: null, truncated: null, ggufFiles: [],
    },
    verdict: {
      state: 'unknown', scope: 'exact_gguf_file_only',
      basis: 'insufficient_evidence', reason: 'metadata_unavailable',
      requiresExactFileSelection: true,
    },
  }

  const json = (body: unknown, status = 200) => ({
    status, contentType: 'application/json', body: JSON.stringify(body),
  })

  const searchPage = (repositories: unknown[], nextCursor: string | null) => ({
    result: {
      state: 'listed', version: 1, page: 1, pageSize: 10,
      source: {
        state: 'available', source: 'hugging_face_public_api',
        observedAt, reason: null,
      },
      droppedRows: 1, repositories, nextCursor, reason: null,
    },
  })

  await page.route('**/api/**', async (route) => {
    const request = route.request()
    const url = new URL(request.url())
    requests.push({
      path: url.pathname,
      method: request.method(),
      body: request.postData() ?? null,
    })
    if (url.pathname === '/api/health') return route.fulfill(json(health))
    if (url.pathname === '/api/settings') return route.fulfill(json(browserSettings()))
    if (url.pathname === '/api/runtime') return route.fulfill(json(runtimeBrowserSnapshot()))
    if (url.pathname === '/api/models') return route.fulfill(json({ models: [] }))
    if (url.pathname === '/api/models/catalog') {
      return route.fulfill(json({
        models: [], live: false,
        source: {
          state: 'stale_cache', source: 'ollama_recommendations_cache',
          observedAt, fetchedAt: '2026-08-01T00:00:00.000Z',
        },
      }))
    }
    if (url.pathname === '/api/models/discovery/hugging-face/search') {
      const body = JSON.parse(request.postData() ?? '{}') as { query?: string }
      if (body.query === 'rate-limited') {
        return route.fulfill(json({
          result: {
            state: 'failed', version: 1, page: 1, pageSize: 10,
            source: {
              state: 'unavailable', source: 'hugging_face_public_api',
              observedAt, reason: 'rate_limited',
            },
            droppedRows: 0, repositories: [], nextCursor: null,
            reason: 'rate_limited',
          },
        }))
      }
      return route.fulfill(json(searchPage([supported, unsupported, unknown], null)))
    }
    return route.fulfill(json(
      { code: 'internal_error', message: url.pathname, details: null }, 500,
    ))
  })

  await page.goto('/')

  const section = page.getByRole('region', { name: 'Hugging Face' })
  const search = page.getByLabel('Поиск репозиториев Hugging Face')
  await expect(search).toBeVisible()
  await expect(page.getByText('Поиск ещё не выполнялся')).toBeVisible()

  // Mount, hover, focus and reload must not reach the discovery boundary.
  await search.hover()
  await search.focus()
  await search.fill('llama gguf')
  const discoveryCalls = () =>
    requests.filter((entry) => entry.path.includes('/discovery/hugging-face/'))
  expect(discoveryCalls()).toHaveLength(0)

  await page.reload()
  await expect(page.getByText('Поиск ещё не выполнялся')).toBeVisible()
  expect(discoveryCalls()).toHaveLength(0)

  // One explicit keyboard submit issues exactly one request.
  await search.fill('llama gguf')
  await search.press('Enter')
  await expect(section.getByText('TheBloke/Llama-2-7B-GGUF')).toBeVisible()
  expect(discoveryCalls()).toHaveLength(1)
  expect(JSON.parse(discoveryCalls()[0]!.body ?? '{}')).toEqual({
    query: 'llama gguf', page: 1, pageSize: 10, cursor: null,
  })

  // The three verdict states stay visibly distinct and truthfully worded.
  await expect(section.getByText('Содержит файлы GGUF')).toBeVisible()
  await expect(section.getByText('Вне GGUF-only scope этого приложения')).toBeVisible()
  await expect(section.getByText('Доказательств недостаточно')).toBeVisible()
  await expect(section.getByText(/не значит, что модель сломана/u)).toBeVisible()
  await expect(section.getByText(/Metadata репозитория прочитать не удалось/u)).toBeVisible()
  await expect(section.getByText(/это не «нашлось меньше»/u)).toBeVisible()
  await expect(section.getByText('Gated — ручное одобрение', { exact: true })).toBeVisible()
  await expect(section.getByText(/token не запрашивается и доступ не открывается/u))
    .toBeVisible()

  // No install affordance exists in this slice.
  for (const name of [/^Установить/u, /^Install/u, /^Pull/u, /^Скачать/u]) {
    await expect(section.getByRole('button', { name })).toHaveCount(0)
  }
  await expect(section.getByText(/Выберите один ниже/u).first()).toBeVisible()

  // The GGUF list is a keyboard-operable disclosure with focus retained.
  const disclosure = section.getByRole('button', { name: /Файлы GGUF: 1/u })
  await expect(disclosure).toHaveAttribute('aria-expanded', 'true')
  await disclosure.press('Enter')
  await expect(disclosure).toHaveAttribute('aria-expanded', 'false')
  await expect(disclosure).toBeFocused()
  await disclosure.press('Enter')
  await expect(disclosure).toHaveAttribute('aria-expanded', 'true')
  await expect(disclosure).toBeFocused()
  await expect(section.getByText('llama-2-7b.Q4_K_M.gguf')).toBeVisible()

  // A rate-limited answer is distinguishable and repeatable from Search itself (D-203: no Retry).
  await search.fill('rate-limited')
  await search.press('Enter')
  const alert = section.getByRole('alert')
  await expect(alert).toContainText(/ограничивает частоту запросов/u)
  await expect(section.getByRole('button', { name: /Повторить/u })).toHaveCount(0)
  await search.press('Enter')
  await expect(alert).toContainText(/ограничивает частоту запросов/u)

  // Primary touch targets in this section meet the documented 44 px minimum.
  const targets = await section.evaluate((root) => {
    const names = ['Искать', 'Загрузить следующую страницу', 'Выбрать']
    const found: Array<{ label: string; height: number }> = []
    for (const element of root.querySelectorAll('button')) {
      const label = (element.textContent ?? '').trim()
      if (!names.some((name) => label.includes(name))) continue
      found.push({ label, height: element.getBoundingClientRect().height })
    }
    const input = root.querySelector('input')
    if (input) {
      found.push({ label: 'input', height: input.getBoundingClientRect().height })
    }
    return found
  })
  expect(targets.length).toBeGreaterThan(0)
  for (const target of targets) {
    expect(target.height, `${target.label} height`).toBeGreaterThanOrEqual(44)
  }

  await page.evaluate(() => { document.documentElement.style.fontSize = '200%' })
  const layout = await page.evaluate(() => ({
    overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
    reducedMotion: matchMedia('(prefers-reduced-motion: reduce)').matches,
    animationDurations: [...document.querySelectorAll<HTMLElement>('*')]
      .map((element) => Number.parseFloat(getComputedStyle(element).animationDuration || '0'))
      .filter(Number.isFinite),
  }))
  expect(layout.overflow).toBeLessThanOrEqual(1)
  expect(layout.reducedMotion).toBe(true)
  expect(Math.max(0, ...layout.animationDurations)).toBeLessThanOrEqual(0.00001)
  expect(pageErrors).toEqual([])

  // Discovery never triggers a pull, probe, prewarm, warm, stop, delete or create.
  const forbidden = requests.filter((entry) =>
    /\/(pull|prewarm|warm|stop|probes|create|imports)\b/u.test(entry.path)
    || entry.method === 'DELETE'
    || entry.method === 'PUT'
    || entry.method === 'PATCH',
  )
  expect(forbidden).toEqual([])

  // Every non-GET request in this run is a discovery POST and nothing else.
  const writes = requests.filter((entry) => entry.method !== 'GET')
  expect(writes.every((entry) =>
    entry.path === '/api/models/discovery/hugging-face/search',
  )).toBe(true)

  // The browser never talks to the provider directly.
  expect(requests.every((entry) => entry.path.startsWith('/api/'))).toBe(true)
})

test('Marketplace confirms one exact GGUF target without downloading or installing it', async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 })
  await page.emulateMedia({ reducedMotion: 'reduce' })
  const observedAt = '2026-08-09T12:00:00.000Z'
  const commit = 'a'.repeat(40)
  const requests: Array<{ url: string; path: string; method: string; body: string | null }> = []
  const pageErrors: string[] = []
  page.on('pageerror', (error) => pageErrors.push(error.message))

  const identity = {
    provider: 'hugging_face',
    owner: 'TheBloke',
    name: 'Llama-2-7B-GGUF',
    repositoryId: 'TheBloke/Llama-2-7B-GGUF',
    comparisonKey: 'thebloke/llama-2-7b-gguf',
  }
  const revision = {
    state: 'exact_commit', commit, source: 'hugging_face_api_model',
  }
  const repository = {
    version: 1, provider: 'hugging_face', identity,
    metadata: 'resolved', observedAt, revision,
    gated: { state: 'gated', mode: 'manual' },
    license: {
      state: 'declared', value: 'apache-2.0',
      source: 'hugging_face_model_tags', confidence: 'declared',
    },
    files: {
      state: 'listed', source: 'hugging_face_api_model', totalFiles: 1,
      malformedEntries: 0, truncated: false,
      ggufFiles: [{
        path: 'llama-2-7b.Q4_K_M.gguf', sizeBytes: 4_000_000_000,
        sizeSource: 'hugging_face_api_model',
      }],
    },
    verdict: {
      state: 'supported', scope: 'exact_gguf_file_only',
      basis: 'exact_gguf_files_listed', reason: null,
      requiresExactFileSelection: true,
    },
  }
  const json = (body: unknown, status = 200) => ({
    status, contentType: 'application/json', body: JSON.stringify(body),
  })
  const health = {
    ok: true, appVersion: 'test',
    application: { state: 'reachable', source: 'application_http', observedAt },
    ollama: {
      installed: true, installSource: 'runtime_response', running: true,
      state: 'reachable', source: 'ollama_api_version', observedAt,
      version: '0.12.6', host: 'http://127.0.0.1:11434', installHint: null,
    },
    hardware: {
      platform: 'darwin', arch: 'arm64', cpuModel: 'fixture', cpuCores: 8,
      totalMemoryBytes: 16_000_000_000, usableMemoryBytes: 12_000_000_000,
      accelerator: 'metal', acceleratorName: 'Fixture Metal', unifiedMemory: true,
      freeDiskBytes: null,
    },
    network: {
      ollamaComReachable: null, checkedAt: null,
      status: 'unknown', source: 'not_checked',
    },
  }

  await page.route('**/api/**', async (route) => {
    const request = route.request()
    const path = new URL(request.url()).pathname
    requests.push({ url: request.url(), path, method: request.method(), body: request.postData() ?? null })
    if (path === '/api/health') return route.fulfill(json(health))
    if (path === '/api/settings') return route.fulfill(json(browserSettings()))
    if (path === '/api/runtime') return route.fulfill(json(runtimeBrowserSnapshot()))
    if (path === '/api/models') return route.fulfill(json({ models: [] }))
    if (path === '/api/models/catalog') {
      return route.fulfill(json({
        models: [], live: false,
        source: {
          state: 'stale_cache', source: 'ollama_recommendations_cache',
          observedAt, fetchedAt: observedAt,
        },
      }))
    }
    if (path === '/api/models/discovery/hugging-face/search') {
      return route.fulfill(json({
        result: {
          state: 'listed', version: 1, page: 1, pageSize: 10,
          source: {
            state: 'available', source: 'hugging_face_public_api',
            observedAt, reason: null,
          },
          droppedRows: 0, repositories: [repository], nextCursor: null, reason: null,
        },
      }))
    }
    if (path === '/api/models/discovery/hugging-face/selection') {
      return route.fulfill(json({
        result: {
          state: 'confirmed', version: 1, repository,
          selection: {
            identity, revision, filePath: 'llama-2-7b.Q4_K_M.gguf',
            sizeBytes: 4_000_000_000, sizeSource: 'hugging_face_api_model',
          },
          fit: {
            state: 'calculated', contextLength: 32_768,
            basis: 'reported_file_size_only',
            calculatedAt: '2026-08-09T12:00:01.000Z',
            hardware: {
              source: 'application_startup_hardware_probe',
              observedAt: '2026-08-09T11:59:00.000Z',
              confidence: 'estimated',
            },
            verdict: {
              level: 'green', summary: 'fixture', contextLength: 32_768,
              modelBytes: 4_000_000_000, kvCacheBytes: 0,
              requiredBytes: 4_000_000_000, usableBytes: 12_000_000_000,
              utilization: 1 / 3, basis: 'vendor_hint', measured: null,
            },
          },
          reason: null,
        },
      }))
    }
    return route.fulfill(json({ code: 'internal_error', message: path, details: null }, 500))
  })

  await page.goto('/')
  const section = page.getByRole('region', { name: 'Hugging Face' })
  const search = page.getByLabel('Поиск репозиториев Hugging Face')
  await search.fill('llama gguf')
  await search.press('Enter')
  const select = section.getByRole('button', {
    name: 'Выбрать этот файл llama-2-7b.Q4_K_M.gguf',
  })
  await expect(select).toBeVisible()
  expect(requests.filter((request) => request.path.endsWith('/selection'))).toHaveLength(0)

  await select.focus()
  await select.press('Enter')
  await expect(section.getByText('Выбранная цель', { exact: true })).toBeVisible()
  const selectionCalls = requests.filter((request) => request.path.endsWith('/selection'))
  expect(selectionCalls).toHaveLength(1)
  expect(JSON.parse(selectionCalls[0]!.body ?? '{}')).toEqual({
    identity,
    revision,
    filePath: 'llama-2-7b.Q4_K_M.gguf',
    contextLength: 32_768,
  })

  await expect(section.getByText(/сообщён API файловых metadata Hugging Face/u))
    .toBeVisible()
  await expect(section.getByText(/не замер и не гарантия влезаемости/u)).toBeVisible()
  await expect(section.getByText(/стартовая проверка железа приложением/u)).toBeVisible()
  await expect(section.getByText(/оценочная уверенность/u)).toBeVisible()
  await expect(section.getByText('Gated — ручное одобрение', { exact: true })).toBeVisible()
  await expect(section.getByRole('paragraph').filter({
    hasText: /^Заявление автора, а не юридическая проверка\.$/u,
  })).toBeVisible()
  const download = section.getByRole('button', { name: 'Скачать точный GGUF' })
  await expect(download).toBeVisible()
  for (const name of [/^Установить/u, /^Install/u, /^Pull/u]) {
    await expect(section.getByRole('button', { name })).toHaveCount(0)
  }

  const change = section.getByRole('button', { name: 'Выбрать другой файл' })
  await expect(change).toBeFocused()
  const targetHeights = await Promise.all([select, download, change].map(async (locator) =>
    locator.evaluate((element) => element.getBoundingClientRect().height)))
  for (const height of targetHeights) expect(height).toBeGreaterThanOrEqual(44)

  // Keep the new confirmed preview open while proving the constrained zoom layout.
  await page.evaluate(() => { document.documentElement.style.fontSize = '200%' })
  const overflow = await page.evaluate(() =>
    document.documentElement.scrollWidth - document.documentElement.clientWidth)
  expect(overflow).toBeLessThanOrEqual(1)

  await change.press('Enter')
  await expect(select).toBeFocused()
  expect(pageErrors).toEqual([])

  const forbidden = requests.filter((request) =>
    /\/(pull|prewarm|warm|stop|probes|create|imports)\b/u.test(request.path)
    || ['DELETE', 'PUT', 'PATCH'].includes(request.method))
  expect(forbidden).toEqual([])
  expect(requests.every((request) => request.path.startsWith('/api/'))).toBe(true)
})

test('Marketplace explicitly downloads and verifies staging provenance without install side effects', async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 })
  await page.emulateMedia({ reducedMotion: 'reduce' })
  const observedAt = '2026-08-09T12:00:00.000Z'
  const commit = 'a'.repeat(40)
  const digest = 'd'.repeat(64)
  const requests: Array<{ url: string; path: string; method: string; body: string | null }> = []
  const identity = {
    provider: 'hugging_face', owner: 'Owner', name: 'Model-GGUF',
    repositoryId: 'Owner/Model-GGUF', comparisonKey: 'owner/model-gguf',
  }
  const revision = { state: 'exact_commit', commit, source: 'hugging_face_api_model' }
  const repository = {
    version: 1, provider: 'hugging_face', identity, metadata: 'resolved', observedAt,
    revision, gated: { state: 'open', mode: null },
    license: {
      state: 'declared', value: 'apache-2.0',
      source: 'hugging_face_model_tags', confidence: 'declared',
    },
    files: {
      state: 'listed', source: 'hugging_face_api_model', totalFiles: 1,
      malformedEntries: 0, truncated: false,
      ggufFiles: [{
        path: 'nested/model Q4.gguf', sizeBytes: 4_000,
        sizeSource: 'hugging_face_api_model', sha256: digest,
        sha256Source: 'hugging_face_lfs_oid',
      }],
    },
    verdict: {
      state: 'supported', scope: 'exact_gguf_file_only',
      basis: 'exact_gguf_files_listed', reason: null, requiresExactFileSelection: true,
    },
  }
  const localCatalogModel = {
    name: 'local-retention-fixture', description: 'Bundled local row retained across HF failure',
    variants: [], contextLength: 32_768, capabilities: ['completion'], vramBytes: null,
    isCloud: false, requiredPlan: null, installed: false,
    fit: {
      level: 'green', summary: 'fixture', contextLength: 8_192, modelBytes: 4_000,
      kvCacheBytes: 0, requiredBytes: 4_000, usableBytes: 12_000_000_000,
      utilization: 4_000 / 12_000_000_000, basis: 'estimate', measured: null,
    },
    source: 'bundled', freshness: 'fallback', sourceObservedAt: observedAt,
    sourceFetchedAt: observedAt,
  }
  const json = (body: unknown, status = 200) => ({
    status, contentType: 'application/json', body: JSON.stringify(body),
  })
  const downloadProvenance = {
    version: 1, identity, revision, remotePath: 'nested/model Q4.gguf',
    license: repository.license, gated: repository.gated,
    sourceUrlPolicy: 'hugging_face_exact_revision_explicit_hosts_v1',
    expectedSizeBytes: 4_000, observedSizeBytes: 4_000,
    checksum: {
      algorithm: 'sha256', expectedDigest: digest,
      observedDigest: digest, relation: 'matched_provider_claim',
    },
    format: {
      kind: 'gguf', magic: 'GGUF', version: 3, inspection: 'bounded_header_only',
    },
    artifact: {
      state: 'managed_staging', id: '11111111-1111-4111-8111-111111111111',
    },
    observedAt, terminalState: 'completed',
  }
  const sseEvents = [
    { type: 'state', seq: 0, data: { version: 1, state: 'preparing' } },
    {
      type: 'progress', seq: 1,
      data: { version: 1, state: 'downloading', completedBytes: 2_000, totalBytes: 4_000 },
    },
    { type: 'state', seq: 2, data: { version: 1, state: 'verifying' } },
    {
      type: 'completed', seq: 3,
      data: {
        version: 1, state: 'completed',
        provenance: downloadProvenance,
      },
    },
  ]
  const importEvents = [
    {
      type: 'state', seq: 0,
      data: { version: 1, state: 'importing', phase: 'creating_model' },
    },
    {
      type: 'failed', seq: 1,
      data: {
        version: 1, state: 'failed', reason: 'probe_not_verified',
        target: {
          state: 'exact', normalizedModelReference: 'owner/model:latest',
          digest: 'manifest-digest', observedAt,
        },
        probe: {
          status: 'degraded', reason: 'provider_error', capability: 'completion',
          source: 'runtime_probe', confidence: 'degraded', observedAt,
          completedAt: observedAt, durationMs: 1, historical: false,
          basis: {
            state: 'exact', keyVersion: 1, probeDefinitionVersion: 1,
            provider: 'ollama', normalizedModelReference: 'owner/model:latest',
            artifactDigest: 'manifest-digest', runtimeVersion: '0.12.6',
            contextLength: 32_768, id: `sha256:${'c'.repeat(64)}`,
          },
        },
      },
    },
    {
      type: 'completed', seq: 1,
      data: {
        version: 1, state: 'completed',
        provenance: {
          version: 1, source: downloadProvenance,
          targetModelName: 'owner/model:latest',
          create: {
            endpoint: '/api/create', input: 'uploaded_sha256_blob_files_map',
            terminalStatus: 'success', startedAt: observedAt, terminalAt: observedAt,
          },
          installation: {
            source: 'ollama_api_tags', normalizedModelReference: 'owner/model:latest',
            digest: 'manifest-digest', runtimeVersion: '0.12.6', observedAt,
          },
          probe: {
            status: 'verified', reason: 'terminal_response', capability: 'completion',
            source: 'runtime_probe', confidence: 'verified', observedAt,
            completedAt: observedAt, durationMs: 1, historical: false,
            basis: {
              state: 'exact', keyVersion: 1, probeDefinitionVersion: 1,
              provider: 'ollama', normalizedModelReference: 'owner/model:latest',
              artifactDigest: 'manifest-digest', runtimeVersion: '0.12.6',
              contextLength: 32_768, id: `sha256:${'b'.repeat(64)}`,
            },
          },
          staging: {
            artifactId: '11111111-1111-4111-8111-111111111111',
            retention: 'deleted_after_verified_success',
          },
          completedAt: observedAt,
        },
      },
    },
  ]
  const installedModel = {
    name: 'owner/model:latest', digest: 'manifest-digest', sizeBytes: 4_000,
    modifiedAt: observedAt, family: 'fixture', parameterSize: '1B', quantization: 'Q4',
    contextLength: 32_768, capabilities: ['completion'], isCloud: false,
    fit: {
      level: 'green', summary: 'fixture', contextLength: 32_768,
      modelBytes: 4_000, kvCacheBytes: 0, requiredBytes: 4_000,
      usableBytes: 12_000_000_000, utilization: 4_000 / 12_000_000_000,
      basis: 'vendor_hint', measured: null,
    },
    descriptor: {
      reference: {
        state: 'canonical', provider: 'ollama', original: 'owner/model:latest',
        normalized: 'owner/model:latest',
      },
      artifact: { state: 'exact_digest', digest: 'manifest-digest' },
      installation: {
        state: 'installed', source: 'ollama_api_tags', observedAt, confidence: 'observed',
      },
      capabilities: {
        state: 'unknown', reason: 'field_not_reported', observedAt, declarations: [],
      },
      freshness: {
        state: 'unknown', source: 'provider', observedAt,
        reason: 'identity_unavailable', offline: false,
      },
    },
  }
  await page.addInitScript(({ downloadEvents, importEvents, installedModel }) => {
    const nativeFetch = window.fetch.bind(window)
    window.fetch = async (input, init) => {
      const raw = input instanceof Request ? input.url : String(input)
      const url = new URL(raw, window.location.href)
      const state = window as unknown as {
        __p2mInstalled?: boolean
        __p2mModelRequests?: number
      }
      if (url.pathname === '/api/models') {
        state.__p2mModelRequests = (state.__p2mModelRequests ?? 0) + 1
        if (state.__p2mInstalled) {
          return new Response(JSON.stringify({ models: [installedModel] }), {
            status: 200, headers: { 'content-type': 'application/json' },
          })
        }
      }
      if (url.pathname === '/api/models/discovery/hugging-face/download') {
        const target = window as unknown as {
          __p2lRequests?: Array<{ url: string; body: string }>
        }
        target.__p2lRequests ??= []
        target.__p2lRequests.push({
          url: url.href,
          body: String(init?.body ?? ''),
        })
        const attempt = target.__p2lRequests.length
        const encoder = new TextEncoder()
        let firstTimer = 0
        let secondTimer = 0
        const stream = new ReadableStream<Uint8Array>({
          start(controller) {
            const send = (event: (typeof downloadEvents)[number]) => controller.enqueue(encoder.encode(
              `id: ${String(event.seq)}\ndata: ${JSON.stringify(event)}\n\n`,
            ))
            send(downloadEvents[0]!)
            send(downloadEvents[1]!)
            firstTimer = window.setTimeout(() => {
              send(downloadEvents[2]!)
              secondTimer = window.setTimeout(() => {
                send(attempt === 1
                  ? {
                      type: 'failed', seq: 3,
                      data: { version: 1, state: 'failed', reason: 'provider_unavailable' },
                    }
                  : downloadEvents[3]!)
                controller.close()
              }, 1_000)
            }, 1_000)
          },
          cancel() {
            window.clearTimeout(firstTimer)
            window.clearTimeout(secondTimer)
          },
        })
        return new Response(stream, { status: 200, headers: { 'content-type': 'text/event-stream' } })
      }
      if (url.pathname === '/api/models/imports/hugging-face-gguf/start') {
        const target = window as unknown as {
          __p2mRequests?: Array<{ url: string; body: string }>
        }
        target.__p2mRequests ??= []
        target.__p2mRequests.push({ url: url.href, body: String(init?.body ?? '') })
        const attempt = target.__p2mRequests.length
        const encoder = new TextEncoder()
        const stream = new ReadableStream<Uint8Array>({
          start(controller) {
            const send = (event: (typeof importEvents)[number]) => controller.enqueue(encoder.encode(
              `id: ${String(event.seq)}\ndata: ${JSON.stringify(event)}\n\n`,
            ))
            send(importEvents[0]!)
            if (attempt === 1) {
              send(importEvents[1]!)
              controller.close()
            } else if (attempt > 2) {
              state.__p2mInstalled = true
              send(importEvents[2]!)
              controller.close()
            }
          },
        })
        return new Response(stream, { status: 200, headers: { 'content-type': 'text/event-stream' } })
      }
      return nativeFetch(input, init)
    }
  }, { downloadEvents: sseEvents, importEvents, installedModel })

  await page.route('**/api/**', async (route) => {
    const request = route.request()
    const path = new URL(request.url()).pathname
    requests.push({ url: request.url(), path, method: request.method(), body: request.postData() ?? null })
    if (path === '/api/health') {
      return route.fulfill(json({
        ok: true, appVersion: 'test',
        application: { state: 'reachable', source: 'application_http', observedAt },
        ollama: {
          installed: true, installSource: 'runtime_response', running: true,
          state: 'reachable', source: 'ollama_api_version', observedAt,
          version: '0.12.6', host: 'http://127.0.0.1:11434', installHint: null,
        },
        hardware: {
          platform: 'darwin', arch: 'arm64', cpuModel: 'fixture', cpuCores: 8,
          totalMemoryBytes: 16_000_000_000, usableMemoryBytes: 12_000_000_000,
          accelerator: 'metal', acceleratorName: 'Fixture Metal', unifiedMemory: true,
          freeDiskBytes: null,
        },
        network: {
          ollamaComReachable: null, checkedAt: null, status: 'unknown', source: 'not_checked',
        },
      }))
    }
    if (path === '/api/settings') return route.fulfill(json(browserSettings()))
    if (path === '/api/runtime') return route.fulfill(json(runtimeBrowserSnapshot()))
    if (path === '/api/models') return route.fulfill(json({ models: [] }))
    if (path === '/api/models/catalog') {
      return route.fulfill(json({
        models: [localCatalogModel], live: false,
        source: {
          state: 'bundled_fallback', source: 'bundled_snapshot',
          observedAt, fetchedAt: observedAt,
        },
      }))
    }
    if (path.endsWith('/search')) {
      return route.fulfill(json({
        result: {
          state: 'listed', version: 1, page: 1, pageSize: 10,
          source: {
            state: 'available', source: 'hugging_face_public_api', observedAt, reason: null,
          },
          droppedRows: 0, repositories: [repository], nextCursor: null, reason: null,
        },
      }))
    }
    if (path.endsWith('/selection')) {
      return route.fulfill(json({
        result: {
          state: 'confirmed', version: 1, repository,
          selection: {
            identity, revision, filePath: 'nested/model Q4.gguf',
            sizeBytes: 4_000, sizeSource: 'hugging_face_api_model',
          },
          fit: {
            state: 'calculated', contextLength: 32_768,
            basis: 'reported_file_size_only', calculatedAt: observedAt,
            hardware: {
              source: 'application_startup_hardware_probe',
              observedAt, confidence: 'estimated',
            },
            verdict: {
              level: 'green', summary: 'fixture', contextLength: 32_768,
              modelBytes: 4_000, kvCacheBytes: 0, requiredBytes: 4_000,
              usableBytes: 12_000_000_000, utilization: 4_000 / 12_000_000_000,
              basis: 'vendor_hint', measured: null,
            },
          },
          reason: null,
        },
      }))
    }
    if (path.endsWith('/download')) throw new Error('download must use the same-origin browser fetch')
    return route.fulfill(json({ code: 'internal_error', message: path, details: null }, 500))
  })

  await page.goto('/')
  const section = page.getByRole('region', { name: 'Hugging Face' })
  const search = page.getByLabel('Поиск репозиториев Hugging Face')
  await search.fill('owner model gguf')
  await search.press('Enter')
  const select = section.getByRole('button', { name: 'Выбрать этот файл nested/model Q4.gguf' })
  await select.press('Enter')
  const download = section.getByRole('button', { name: 'Скачать точный GGUF' })
  await expect(download).toBeVisible()
  expect(requests.filter((request) => request.path.endsWith('/download'))).toHaveLength(0)
  const catalogCallsBeforeDownload = requests.filter(
    (request) => request.path === '/api/models/catalog',
  ).length

  await page.evaluate(() => { document.documentElement.style.fontSize = '200%' })
  await download.press('Enter')
  const meter = section.getByRole('meter', { name: 'Прогресс скачивания точного GGUF' })
  await expect(meter).toHaveAttribute('aria-valuenow', '50')
  await expect(section.getByText(/2.*КБ.*4.*КБ/u)).toBeVisible()
  const runningLayout = await page.evaluate(() => {
    const meterElement = document.querySelector('[role="meter"]')
    const cancel = [...document.querySelectorAll('button')].find(
      (button) => button.textContent?.includes('Отменить скачивание'),
    )
    const box = cancel?.getBoundingClientRect()
    return {
      overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
      cancelHeight: box?.height ?? 0,
      transitionMs: meterElement?.firstElementChild
        ? Number.parseFloat(getComputedStyle(meterElement.firstElementChild).transitionDuration) * 1_000
        : Number.POSITIVE_INFINITY,
    }
  })
  expect(runningLayout.overflow).toBeLessThanOrEqual(1)
  expect(runningLayout.cancelHeight).toBeGreaterThanOrEqual(44)
  expect(runningLayout.transitionMs).toBeLessThanOrEqual(0.01)
  await expect(section.getByText(/Соединение с provider не установлено/u)).toBeVisible()
  await expect(page.getByText('Bundled local row retained across HF failure')).toHaveCount(1)
  expect(requests.filter((request) => request.path === '/api/models/catalog')).toHaveLength(
    catalogCallsBeforeDownload,
  )
  const downloadAgain = section.getByRole('button', { name: 'Скачать точный GGUF' })
  await downloadAgain.press('Enter')
  const completed = section.getByText('Staging artifact скачан и проверен')
  await expect(completed).toBeVisible()
  await expect(section.getByText(new RegExp(digest, 'u'))).toBeVisible()
  await expect(section.getByText(/не Installed и не runtime verified/u)).toBeVisible()
  const downloadCalls = await page.evaluate(() => (
    window as unknown as { __p2lRequests?: Array<{ url: string; body: string }> }
  ).__p2lRequests ?? [])
  expect(downloadCalls).toHaveLength(2)
  for (const downloadCall of downloadCalls) {
    expect(downloadCall.url).toBe(
      new URL('/api/models/discovery/hugging-face/download', page.url()).href,
    )
    expect(JSON.parse(downloadCall.body)).toEqual({
      identity, revision, filePath: 'nested/model Q4.gguf', contextLength: 32_768,
    })
  }
  await expect(completed.locator('..')).toBeFocused()
  await expect(section.getByRole('button', { name: 'Проверить локальный импорт' })).toHaveCount(1)
  await page.evaluate(() => { document.documentElement.style.fontSize = '100%' })

  // P2-M is a separate explicit mutation: editing the target is inert and the
  // confirmation shows the exact owned artifact/target/context tuple.
  const importCalls = async () => page.evaluate(() => (
    window as unknown as { __p2mRequests?: Array<{ url: string; body: string }> }
  ).__p2mRequests ?? [])
  const target = section.getByLabel('Локальная ссылка модели Ollama')
  await target.fill('Owner/Model')
  expect(await importCalls()).toHaveLength(0)
  await section.getByRole('button', { name: 'Проверить локальный импорт' }).press('Enter')
  const dialog = page.getByRole('dialog', { name: 'Создать эту локальную модель Ollama?' })
  await expect(dialog).toContainText('11111111-1111-4111-8111-111111111111')
  await expect(dialog).toContainText('Owner/Model')
  const confirmationHeights = await dialog.getByRole('button').evaluateAll((buttons) =>
    buttons.map((button) => button.getBoundingClientRect().height))
  expect(confirmationHeights.length).toBeGreaterThanOrEqual(3)
  for (const height of confirmationHeights) expect(height).toBeGreaterThanOrEqual(44)
  expect(await importCalls()).toHaveLength(0)

  const modelCalls = () => page.evaluate(() => (
    window as unknown as { __p2mModelRequests?: number }
  ).__p2mModelRequests ?? 0)
  const modelsBeforeImport = await modelCalls()
  await dialog.getByRole('button', { name: 'Создать и проверить' }).press('Enter')
  const failedImport = section.getByRole('alert')
  await expect(failedImport).toContainText('Импорт не завершён')
  await expect(failedImport).toContainText('Evidence controlled completion probe')
  await expect(failedImport).toContainText('Неполный результат')
  await expect(failedImport).toBeFocused()
  expect(await modelCalls()).toBe(modelsBeforeImport)

  await section.getByRole('button', { name: 'Проверить локальный импорт' }).press('Enter')
  await expect(target).toBeFocused()
  await section.getByRole('button', { name: 'Проверить локальный импорт' }).press('Enter')
  await page.getByRole('dialog').getByRole('button', { name: 'Создать и проверить' }).press('Enter')
  const runningImport = section.getByText('Создаём локальную модель Ollama…', { exact: true })
  await expect(runningImport).toHaveCount(1)
  await expect(runningImport).toHaveAttribute('role', 'status')
  const cancelImport = section.getByRole('button', { name: 'Отменить импорт' })
  await expect(cancelImport).toHaveCount(1)
  expect(await cancelImport.evaluate((element) => element.getBoundingClientRect().height))
    .toBeGreaterThanOrEqual(44)
  await cancelImport.press('Enter')
  await expect(section.getByText('Результат импорта требует внимания')).toHaveCount(1)
  await expect(section.getByText(/Create мог начаться/u)).toHaveCount(1)
  await expect(section.getByText('Установлено и проверено runtime')).toHaveCount(0)
  expect(await modelCalls()).toBe(modelsBeforeImport)

  await section.getByRole('button', { name: 'Проверить локальный импорт' }).press('Enter')
  await expect(target).toBeFocused()
  await section.getByRole('button', { name: 'Проверить локальный импорт' }).press('Enter')
  await page.getByRole('dialog').getByRole('button', { name: 'Создать и проверить' }).press('Enter')
  const installed = section.getByText('Установлено и проверено runtime')
  await expect(installed).toHaveCount(1)
  await expect(section.getByText(/новом локальном sample \/api\/tags/u)).toHaveCount(1)
  await expect(section.getByText(/completion probe получил свежий/u)).toHaveCount(1)
  await expect(section.getByText(/owner\/model:latest, manifest-digest/u)).toHaveCount(1)
  await expect.poll(modelCalls)
    .toBe(modelsBeforeImport + 1)
  const installedRegion = page.getByRole('heading', { name: 'Установленные' })
    .locator('xpath=ancestor::section[1]')
  await expect(installedRegion.getByText('owner/model:latest', { exact: true })).toHaveCount(1)
  await expect(installedRegion.getByText('1 модель', { exact: true })).toHaveCount(1)
  const p2mCalls = await importCalls()
  expect(p2mCalls).toHaveLength(3)
  for (const importCall of p2mCalls) {
    expect(new URL(importCall.url).pathname).toBe('/api/models/imports/hugging-face-gguf/start')
    expect(JSON.parse(importCall.body)).toEqual({
      artifactId: '11111111-1111-4111-8111-111111111111',
      targetModelName: 'Owner/Model', contextLength: 32_768,
    })
  }
  await expect(installed.locator('..').locator('..')).toBeFocused()

  await page.evaluate(() => { document.documentElement.style.fontSize = '200%' })
  const layout = await page.evaluate(() => ({
    overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
    reducedMotion: matchMedia('(prefers-reduced-motion: reduce)').matches,
  }))
  expect(layout.overflow).toBeLessThanOrEqual(1)
  expect(layout.reducedMotion).toBe(true)

  const forbidden = requests.filter((request) =>
    /\/(pull|prewarm|warm|stop|probes|create)\b/u.test(request.path)
    || ['DELETE', 'PUT', 'PATCH'].includes(request.method))
  expect(forbidden).toEqual([])
  const applicationOrigin = new URL(page.url()).origin
  expect(requests.every((request) => (
    request.path.startsWith('/api/') && new URL(request.url).origin === applicationOrigin
  ))).toBe(true)
})
