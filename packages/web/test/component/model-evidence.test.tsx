import { render, screen, waitFor } from '@testing-library/react'
import type { Health, InstalledModelDescriptor } from '@alamo/contract'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { LauncherPage } from '../../src/features/launcher/LauncherPage.tsx'
import { api } from '../../src/lib/api.ts'
import {
  InstalledEvidenceDetails,
  InstalledEvidenceSummary,
} from '../../src/features/models/InstalledEvidence.tsx'

const OBSERVED_AT = '2026-08-03T00:00:00.000Z'
const HEALTH: Health = {
  ok: true,
  appVersion: 'test',
  application: { state: 'reachable', source: 'application_http', observedAt: OBSERVED_AT },
  ollama: {
    installed: true, running: true, state: 'reachable', source: 'ollama_api_version',
    observedAt: OBSERVED_AT, version: '0.12.6', host: 'http://fixture.invalid', installHint: null,
  },
  hardware: {
    platform: 'darwin', arch: 'arm64', cpuModel: 'fixture', cpuCores: 8,
    totalMemoryBytes: 16_000_000_000, usableMemoryBytes: 12_000_000_000,
    accelerator: 'metal', acceleratorName: 'fixture', unifiedMemory: true, freeDiskBytes: null,
  },
  network: { ollamaComReachable: null, checkedAt: null, status: 'unknown', source: 'not_checked' },
}

afterEach(() => vi.restoreAllMocks())

function descriptor(
  capabilities: InstalledModelDescriptor['capabilities'],
): InstalledModelDescriptor {
  return {
    reference: {
      state: 'canonical',
      provider: 'ollama',
      original: 'Registry.Example/Team/Model:Q4',
      normalized: 'registry.example/team/model:q4',
    },
    artifact: { state: 'exact_digest', digest: 'sha256:fixture' },
    installation: {
      state: 'installed',
      source: 'ollama_api_tags',
      observedAt: OBSERVED_AT,
      confidence: 'observed',
    },
    capabilities,
  }
}

const basis = {
  reference: {
    state: 'canonical' as const,
    provider: 'ollama' as const,
    original: 'Registry.Example/Team/Model:Q4',
    normalized: 'registry.example/team/model:q4',
  },
  artifact: { state: 'exact_digest' as const, digest: 'sha256:fixture' },
  runtime: {
    state: 'sourced' as const,
    runtime: 'ollama' as const,
    version: '0.12.6',
    source: 'ollama_api_version' as const,
    observedAt: OBSERVED_AT,
    confidence: 'observed' as const,
  },
}

const showBasis = {
  ...basis,
  artifact: {
    state: 'unknown' as const,
    digest: null,
    reason: 'detail_not_bound_to_digest' as const,
  },
}

describe('installed model evidence projection', () => {
  it('shows canonical exact identity and matching declaration provenance', () => {
    const model = descriptor({
      state: 'declared',
      reason: null,
      observedAt: OBSERVED_AT,
      declarations: [
        {
          capabilities: ['completion', 'tools'],
          source: 'ollama_api_tags',
          observedAt: OBSERVED_AT,
          confidence: 'declared',
          basis,
        },
        {
          capabilities: ['tools', 'completion'],
          source: 'ollama_api_show',
          observedAt: OBSERVED_AT,
          confidence: 'declared',
          basis: showBasis,
        },
      ],
    })
    const view = render(<><InstalledEvidenceSummary descriptor={model} /><InstalledEvidenceDetails descriptor={model} /></>)
    expect(screen.getByText('registry.example/team/model:q4')).toBeTruthy()
    expect(screen.getAllByText('sha256:fixture').length).toBeGreaterThan(0)
    expect(screen.getByText('Documented provider declarations совпадают.')).toBeTruthy()
    expect(screen.getByText(/не является controlled probe/u)).toBeTruthy()
    expect(view.container.querySelector('.text-\\[var\\(--color-fit-green\\)\\]')).toBeNull()
  })

  it('keeps unknown and degraded states visible instead of rendering unsupported', () => {
    const unknown = descriptor({
      state: 'unknown',
      reason: 'field_not_reported',
      observedAt: OBSERVED_AT,
      declarations: [],
    })
    const degraded = descriptor({
      state: 'degraded',
      reason: 'conflicting_provider_declarations',
      observedAt: OBSERVED_AT,
      declarations: [
        {
          capabilities: ['completion'], source: 'ollama_api_tags', observedAt: OBSERVED_AT,
          confidence: 'declared', basis,
        },
        {
          capabilities: ['tools'], source: 'ollama_api_show', observedAt: OBSERVED_AT,
          confidence: 'declared', basis,
        },
      ],
    })
    const view = render(<><InstalledEvidenceDetails descriptor={unknown} /><InstalledEvidenceDetails descriptor={degraded} /></>)
    expect(view.container.textContent).toContain('Provider не сообщил capability declarations.')
    expect(view.container.textContent).toContain('Provider declarations расходятся')
    expect(view.container.textContent).not.toContain('unsupported')
  })

  it('explains why ambiguous name-based evidence is not assigned', () => {
    const ambiguous = descriptor({
      state: 'degraded',
      reason: 'artifact_identity_ambiguous',
      observedAt: OBSERVED_AT,
      declarations: [
        {
          capabilities: ['completion'], source: 'ollama_api_tags', observedAt: OBSERVED_AT,
          confidence: 'declared', basis,
        },
      ],
    })
    render(<InstalledEvidenceDetails descriptor={ambiguous} />)
    expect(screen.getByText(/detail evidence по имени не привязан/u)).toBeTruthy()
  })

  it('uses English source/fallback copy when the document locale is English', () => {
    document.documentElement.lang = 'en'
    const model = descriptor({
      state: 'unknown', reason: 'provider_unavailable', observedAt: OBSERVED_AT, declarations: [],
    })
    render(<InstalledEvidenceDetails descriptor={model} />)
    expect(screen.getByText('One provider source was unavailable.')).toBeTruthy()
    expect(screen.getByText(/not a controlled probe/u)).toBeTruthy()
    document.documentElement.lang = 'ru'
  })

  it('keeps installed loading and healthy empty states distinct', async () => {
    let resolveModels!: (value: { models: [] }) => void
    vi.spyOn(api, 'listModels').mockImplementation(
      () => new Promise((resolve) => { resolveModels = resolve }),
    )
    vi.spyOn(api, 'listCatalog').mockResolvedValue({ models: [], live: false })
    const view = render(<LauncherPage health={HEALTH} />)
    expect(view.container.querySelectorAll('[aria-hidden="true"]').length).toBeGreaterThan(0)
    resolveModels({ models: [] })
    await waitFor(() => expect(screen.getByText('Пока ничего не установлено')).toBeTruthy())
  })
})
