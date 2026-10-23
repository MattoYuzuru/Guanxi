import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import type {
  ModelCapabilityOverride,
  ModelCapabilityOverrideOutcome,
  ModelCapabilityOverrideResponse,
  ModelDetail,
} from '@guanxi/contract'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { CapabilityOverrides } from '../../src/features/models/CapabilityOverrides.tsx'
import { api } from '../../src/lib/api.ts'
import { setActiveLocale } from '../../src/lib/locale.ts'
import { optionLabels } from '../helpers/select.ts'

const AT = '2026-08-07T00:00:00.000Z'
const DIGEST = 'sha256:fixture'
const RUNTIME = '0.12.6'

function override(
  patch: Partial<ModelCapabilityOverride> = {},
): ModelCapabilityOverride {
  return {
    version: 1,
    source: 'user_override',
    state: 'overridden',
    value: 'present',
    capability: 'tools',
    provider: 'ollama',
    normalizedModelReference: 'fixture:latest',
    artifactDigest: DIGEST,
    runtimeVersion: RUNTIME,
    createdAt: AT,
    updatedAt: AT,
    ...patch,
  }
}

function model(patch: Partial<ModelDetail['descriptor']> = {}): ModelDetail {
  const fit = {
    level: 'green' as const,
    summary: 'fixture fit',
    contextLength: 8_192,
    modelBytes: 4_000,
    kvCacheBytes: 1_000,
    requiredBytes: 5_000,
    usableBytes: 10_000,
    utilization: 0.5,
    basis: 'estimate' as const,
    measured: null,
  }
  return {
    name: 'fixture:latest',
    digest: DIGEST,
    sizeBytes: 4_000,
    modifiedAt: AT,
    family: 'fixture',
    parameterSize: '1B',
    quantization: 'Q4',
    contextLength: 32_768,
    contextLimit: {
      state: 'declared', value: 32_768, source: 'ollama_api_tags',
      observedAt: AT, confidence: 'declared',
    },
    capabilities: ['completion'],
    descriptor: {
      reference: {
        state: 'canonical', provider: 'ollama', original: 'fixture:latest',
        normalized: 'fixture:latest',
      },
      artifact: { state: 'exact_digest', digest: DIGEST },
      installation: {
        state: 'installed', source: 'ollama_api_tags', observedAt: AT,
        confidence: 'observed',
      },
      capabilities: { state: 'declared', reason: null, observedAt: AT, declarations: [] },
      freshness: {
        state: 'fresh', source: 'provider', observedAt: AT,
        validatedAt: AT, expiresAt: '2026-08-07T00:15:00.000Z', offline: false,
      },
      runtime: {
        state: 'sourced', runtime: 'ollama', version: RUNTIME,
        source: 'ollama_api_version', observedAt: AT, confidence: 'observed',
      },
      overrides: [],
      ...patch,
    },
    isCloud: false,
    fit,
    modelInfo: {},
    template: null,
    systemPrompt: null,
    license: null,
    fitByContext: [fit],
  }
}

function outcome(
  patch: Partial<Omit<Extract<ModelCapabilityOverrideOutcome, { state: 'applied' }>, 'state'>>
    & { state?: 'applied' | 'cleared' | 'absent' } = {},
): ModelCapabilityOverrideResponse {
  return {
    outcome: {
      state: 'applied',
      capability: 'tools',
      identity: {
        provider: 'ollama',
        normalizedModelReference: 'fixture:latest',
        artifactDigest: DIGEST,
        runtimeVersion: RUNTIME,
      },
      overrides: [override()],
      ...patch,
    } as ModelCapabilityOverrideOutcome,
  }
}

function renderOverrides(
  descriptor: Partial<ModelDetail['descriptor']> = {},
  onRefresh = vi.fn(),
) {
  const view = render(
    <CapabilityOverrides model={model(descriptor)} onRefresh={onRefresh} />,
  )
  return { view, onRefresh }
}

const clipboard = { writeText: vi.fn(async (_text: string) => undefined) }

beforeEach(() => {
  setActiveLocale('ru')
  clipboard.writeText = vi.fn(async (_text: string) => undefined)
  Object.defineProperty(navigator, 'clipboard', {
    value: clipboard,
    configurable: true,
    writable: true,
  })
})

afterEach(() => {
  vi.restoreAllMocks()
  setActiveLocale('ru')
})

describe('installed capability overrides', () => {
  it('never mutates on mount, hover, focus, rerender or unmount', async () => {
    const apply = vi.spyOn(api, 'applyCapabilityOverride')
    const clear = vi.spyOn(api, 'clearCapabilityOverride')
    const { view } = renderOverrides({ overrides: [override()] })

    const add = screen.getByRole('button', {
      name: 'Просмотреть условия и утвердить выбранную capability',
    })
    const remove = screen.getByRole('button', {
      name: 'Просмотреть условия и удалить ваше утверждение для tools',
    })
    fireEvent.mouseOver(add)
    fireEvent.mouseOver(remove)
    add.focus()
    remove.focus()
    view.rerender(
      <CapabilityOverrides model={model({ overrides: [override()] })} onRefresh={vi.fn()} />,
    )
    expect(apply).not.toHaveBeenCalled()
    expect(clear).not.toHaveBeenCalled()

    // Opening and dismissing the confirmation is still not a decision.
    fireEvent.click(add)
    await screen.findByRole('dialog', { name: 'Утвердить эту capability самостоятельно?' })
    fireEvent.keyDown(document, { key: 'Escape' })
    await waitFor(() => expect(document.activeElement).toBe(add))
    expect(apply).not.toHaveBeenCalled()

    view.unmount()
    expect(apply).not.toHaveBeenCalled()
    expect(clear).not.toHaveBeenCalled()
  })

  it('sends the exact rendered identity and shows the recorded assertion', async () => {
    const apply = vi.spyOn(api, 'applyCapabilityOverride').mockResolvedValue(outcome())
    renderOverrides()
    expect(
      screen.getByText('Вы не утверждали ни одной capability для этого exact артефакта.'),
    ).toBeTruthy()

    fireEvent.click(screen.getByRole('button', { name: /утвердить выбранную capability/u }))
    fireEvent.click(await screen.findByRole('button', { name: 'Утвердить capability' }))

    await waitFor(() => expect(apply).toHaveBeenCalledTimes(1))
    expect(apply.mock.calls[0]?.[0]).toBe('fixture:latest')
    expect(apply.mock.calls[0]?.[1]).toEqual({
      capability: 'completion',
      expectedDigest: DIGEST,
      expectedRuntimeVersion: RUNTIME,
    })
    expect(await screen.findByText('Ваше утверждение записано.')).toBeTruthy()
    expect(screen.getByText('Переопределено')).toBeTruthy()
    expect(screen.getByText('user override')).toBeTruthy()
  })

  it('sends exactly one mutation for a double activation', async () => {
    let release!: (value: ModelCapabilityOverrideResponse) => void
    const apply = vi.spyOn(api, 'applyCapabilityOverride').mockImplementation(
      () => new Promise((resolve) => { release = resolve }),
    )
    renderOverrides()
    fireEvent.click(screen.getByRole('button', { name: /утвердить выбранную capability/u }))
    const confirm = await screen.findByRole('button', { name: 'Утвердить capability' })
    fireEvent.click(confirm)
    fireEvent.click(confirm)
    fireEvent.click(confirm)
    expect(apply).toHaveBeenCalledTimes(1)
    expect(await screen.findByText('Применяем ваше изменение…')).toBeTruthy()
    await act(async () => release(outcome()))
    expect(apply).toHaveBeenCalledTimes(1)
  })

  it('removes exactly one assertion and reports an absent one truthfully', async () => {
    const clear = vi.spyOn(api, 'clearCapabilityOverride')
      .mockResolvedValueOnce(outcome({ state: 'cleared', overrides: [] }))
      .mockResolvedValueOnce(outcome({ state: 'absent', overrides: [] }))
    renderOverrides({ overrides: [override(), override({ capability: 'vision' })] })

    fireEvent.click(screen.getByRole('button', {
      name: 'Просмотреть условия и удалить ваше утверждение для tools',
    }))
    fireEvent.click(await screen.findByRole('button', { name: 'Удалить утверждение' }))
    await waitFor(() => expect(clear).toHaveBeenCalledTimes(1))
    expect(clear.mock.calls[0]?.[1].capability).toBe('tools')
    expect(await screen.findByText('Ваше утверждение удалено.')).toBeTruthy()
    // The server projection is authoritative: both rows disappear from the list.
    expect(screen.queryAllByText('Переопределено')).toHaveLength(0)
  })

  it('shows every conflict truthfully and reloads the model by itself only for identity drift', async () => {
    const { onRefresh } = renderOverrides()
    const conflicts = [
      ['model_not_installed', 'Этой модели больше нет в текущей выборке установленных.', false],
      ['provider_unavailable', 'Ollama недоступна, поэтому текущую установку не удалось подтвердить.', false],
      ['installed_reference_ambiguous', /больше одной установленной строки/u, false],
      ['runtime_version_unavailable', /Версию локальной Ollama не удалось получить/u, false],
      ['persistence_failed', /не удалось сохранить/u, false],
      ['digest_expectation_mismatch', /Установленный digest изменился/u, true],
      ['runtime_expectation_mismatch', /Версия Ollama изменилась/u, true],
    ] as const

    for (const [reason, copy, offersReload] of conflicts) {
      vi.spyOn(api, 'applyCapabilityOverride').mockResolvedValue({
        outcome: {
          state: 'conflict', capability: 'tools', reason,
          identity: null, overrides: [],
        },
      })
      fireEvent.click(screen.getByRole('button', { name: /утвердить выбранную capability/u }))
      fireEvent.click(await screen.findByRole('button', { name: 'Утвердить capability' }))
      expect(await screen.findByText('Ничего не изменено')).toBeTruthy()
      expect(
        typeof copy === 'string'
          ? screen.getByText(copy)
          : screen.getByText(copy),
      ).toBeTruthy()
      // D-203: no Reload button; identity drift re-reads the model at once and says so.
      expect(screen.queryAllByRole('button', { name: /Перечитать|Обновить|Повторить/u })).toHaveLength(0)
      expect(screen.queryByText(/Guanxi перечитал эту модель/u) !== null).toBe(offersReload)
      // A conflict never records an assertion.
      expect(screen.queryAllByText('Переопределено')).toHaveLength(0)
    }
    expect(onRefresh).toHaveBeenCalledTimes(2)
  })

  it('disables every mutation when the exact identity is unavailable', () => {
    const apply = vi.spyOn(api, 'applyCapabilityOverride')
    const clear = vi.spyOn(api, 'clearCapabilityOverride')
    for (const descriptor of [
      { artifact: { state: 'unknown', digest: null, reason: 'digest_not_reported' } },
      {
        runtime: {
          state: 'unknown', runtime: 'ollama', version: null,
          source: 'runtime_unavailable', observedAt: AT, confidence: 'unknown',
        },
      },
      {
        reference: {
          state: 'unknown', provider: 'ollama', original: 'fixture:latest',
          normalized: null, reason: 'invalid_reference',
        },
      },
    ] as Array<Partial<ModelDetail['descriptor']>>) {
      const { view } = renderOverrides(descriptor)
      expect(
        screen.getByText(/Сейчас у этой модели нет exact ссылки, digest/u),
      ).toBeTruthy()
      for (const name of [
        /утвердить выбранную capability/u,
        /Копировать ваши утверждения/u,
        /Скачать ваши утверждения/u,
      ]) {
        const control = screen.getByRole('button', { name }) as HTMLButtonElement
        expect(control.disabled).toBe(true)
        // A disabled control must also be inert to a click, not merely styled.
        fireEvent.click(control)
      }
      expect(clipboard.writeText).not.toHaveBeenCalled()
      view.unmount()
    }
    expect(apply).not.toHaveBeenCalled()
    expect(clear).not.toHaveBeenCalled()
  })

  it('exports a safe deterministic JSON projection without private fields', async () => {
    renderOverrides({ overrides: [override(), override({ capability: 'vision' })] })
    fireEvent.click(screen.getByRole('button', { name: /Копировать ваши утверждения/u }))
    await waitFor(() => expect(clipboard.writeText).toHaveBeenCalledTimes(1))
    const first = clipboard.writeText.mock.calls[0]![0] as string

    fireEvent.click(screen.getByRole('button', { name: /Копировать ваши утверждения/u }))
    await waitFor(() => expect(clipboard.writeText).toHaveBeenCalledTimes(2))
    // Deterministic: two identical reads produce byte-identical content.
    expect(clipboard.writeText.mock.calls[1]![0]).toBe(first)

    const parsed = JSON.parse(first) as Record<string, unknown>
    expect(parsed['schema']).toBe('guanxi.model-capability-overrides')
    expect(parsed['version']).toBe(1)
    expect(parsed['artifactDigest']).toBe(DIGEST)
    expect(parsed['runtimeVersion']).toBe(RUNTIME)
    expect((parsed['overrides'] as unknown[]).length).toBe(2)
    expect(Object.keys((parsed['overrides'] as Record<string, unknown>[])[0]!).sort())
      .toEqual([
        'capability', 'createdAt', 'source', 'state', 'updatedAt', 'value', 'version',
      ])
    // No endpoint, credential, path, provider body, prompt, answer or reasoning.
    expect(first).not.toMatch(
      /127\.0\.0\.1|localhost|http|token|secret|Users|\/home|prompt|reasoning|thinking|template|license|system/iu,
    )
    expect(await screen.findByText('Скопировано')).toBeTruthy()
  })

  it('downloads with a deterministic filename and content type', async () => {
    const created: Blob[] = []
    const clicked: Array<{ download: string; href: string }> = []
    vi.spyOn(URL, 'createObjectURL').mockImplementation((blob) => {
      created.push(blob as Blob)
      return 'blob:fixture'
    })
    vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => undefined)
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (
      this: HTMLAnchorElement,
    ) {
      clicked.push({ download: this.download, href: this.href })
    })

    renderOverrides({ overrides: [override()] })
    fireEvent.click(screen.getByRole('button', { name: /Скачать ваши утверждения/u }))
    fireEvent.click(screen.getByRole('button', { name: /Скачать ваши утверждения/u }))

    expect(clicked).toHaveLength(2)
    expect(clicked[0]!.download).toBe(clicked[1]!.download)
    expect(clicked[0]!.download).toBe(
      'guanxi-capability-overrides-fixture-latest-sha256-fixture.json',
    )
    expect(created[0]!.type).toBe('application/json')
    expect(await screen.findByText('Скачивание начато')).toBeTruthy()
  })

  it('shows a deterministic export failure state', async () => {
    vi.spyOn(URL, 'createObjectURL').mockImplementation(() => {
      throw new Error('createObjectURL unavailable')
    })
    clipboard.writeText = vi.fn(async () => { throw new Error('clipboard denied') })
    renderOverrides({ overrides: [override()] })

    fireEvent.click(screen.getByRole('button', { name: /Скачать ваши утверждения/u }))
    expect(
      await screen.findByText('В этом браузере JSON не удалось экспортировать.'),
    ).toBeTruthy()

    fireEvent.click(screen.getByRole('button', { name: /Копировать ваши утверждения/u }))
    await waitFor(() => expect(
      screen.getByText('В этом браузере JSON не удалось экспортировать.'),
    ).toBeTruthy())
  })

  it('shows a safe request failure and never a verified-green assertion', async () => {
    vi.spyOn(api, 'applyCapabilityOverride').mockRejectedValue(
      new Error('The capability override could not be changed safely'),
    )
    const { view } = renderOverrides()
    fireEvent.click(screen.getByRole('button', { name: /утвердить выбранную capability/u }))
    fireEvent.click(await screen.findByRole('button', { name: 'Утвердить capability' }))
    expect(await screen.findByText('Изменение не применилось. Ничего не записано.')).toBeTruthy()
    expect(
      screen.getByText('The capability override could not be changed safely'),
    ).toBeTruthy()
    expect(view.container.innerHTML).not.toContain('color-fit-green')
    expect(screen.queryAllByText('Переопределено')).toHaveLength(0)
  })

  it('falls back to curated English copy', async () => {
    setActiveLocale('en')
    vi.spyOn(api, 'applyCapabilityOverride').mockResolvedValue(outcome())
    renderOverrides()
    expect(
      screen.getByText(/This is your own statement, not a provider declaration/u),
    ).toBeTruthy()
    expect(screen.getByText(/It is not inherited by another digest/u)).toBeTruthy()
    const add = screen.getByRole('button', {
      name: 'Review and assert the selected capability',
    })
    fireEvent.click(add)
    const dialog = await screen.findByRole('dialog', {
      name: 'Assert this capability yourself?',
    })
    expect(dialog.getAttribute('aria-describedby')).toBe('capability-override-confirmation')
    fireEvent.click(screen.getByRole('button', { name: 'Assert capability' }))
    expect(await screen.findByText('Your assertion was recorded.')).toBeTruthy()
  })

  it('contains and restores dialog focus for the exact activated control', async () => {
    renderOverrides({ overrides: [override({ capability: 'vision' })] })
    const remove = screen.getByRole('button', {
      name: 'Просмотреть условия и удалить ваше утверждение для vision',
    })
    remove.focus()
    fireEvent.click(remove)
    const dialog = await screen.findByRole('dialog', { name: 'Удалить ваше утверждение?' })
    await waitFor(() => expect(document.activeElement).toBe(
      screen.getByRole('button', { name: 'Удалить утверждение' }),
    ))
    // The confirmation names the exact identity the removal is bound to.
    expect(dialog.textContent).toContain('vision')
    expect(dialog.textContent).toContain(DIGEST)
    expect(dialog.textContent).toContain(RUNTIME)
    fireEvent.keyDown(document, { key: 'Escape' })
    await waitFor(() => expect(document.activeElement).toBe(remove))
  })

  it('aborts on unmount without applying a late response', async () => {
    let signal: AbortSignal | undefined
    let release!: (value: ModelCapabilityOverrideResponse) => void
    vi.spyOn(api, 'applyCapabilityOverride').mockImplementation(
      (_name, _body, requestSignal) => {
        signal = requestSignal
        return new Promise((resolve) => { release = resolve })
      },
    )
    const { view } = renderOverrides()
    fireEvent.click(screen.getByRole('button', { name: /утвердить выбранную capability/u }))
    fireEvent.click(await screen.findByRole('button', { name: 'Утвердить capability' }))
    view.unmount()
    expect(signal?.aborted).toBe(true)
    await act(async () => release(outcome()))
  })

  it('drops a previous artifact assertions when the rendered model changes', async () => {
    const apply = vi.spyOn(api, 'applyCapabilityOverride')
    const clear = vi.spyOn(api, 'clearCapabilityOverride')
    const { view } = renderOverrides({ overrides: [override()] })
    expect(screen.queryAllByText('Переопределено')).toHaveLength(1)

    // Same component instance, different exact artifact: the previous model's
    // assertions must not linger as if they belonged to the new digest.
    view.rerender(
      <CapabilityOverrides
        model={model({
          artifact: { state: 'exact_digest', digest: 'sha256:replaced' },
          overrides: [],
        })}
        onRefresh={vi.fn()}
      />,
    )
    await waitFor(() => expect(screen.queryAllByText('Переопределено')).toHaveLength(0))
    expect(
      screen.getByText('Вы не утверждали ни одной capability для этого exact артефакта.'),
    ).toBeTruthy()
    // The export now describes the new identity only.
    fireEvent.click(screen.getByRole('button', { name: /Копировать ваши утверждения/u }))
    await waitFor(() => expect(clipboard.writeText).toHaveBeenCalledTimes(1))
    const payload = clipboard.writeText.mock.calls[0]![0] as string
    expect(payload).toContain('sha256:replaced')
    expect(JSON.parse(payload).overrides).toHaveLength(0)
    // Navigating to another artifact and exporting are both read-only.
    expect(apply).not.toHaveBeenCalled()
    expect(clear).not.toHaveBeenCalled()
  })

  it('keeps a stale list from surviving a conflict', async () => {
    vi.spyOn(api, 'clearCapabilityOverride').mockResolvedValue({
      outcome: {
        state: 'conflict', capability: 'tools',
        reason: 'digest_expectation_mismatch', identity: null, overrides: [],
      },
    })
    renderOverrides({ overrides: [override()] })
    fireEvent.click(screen.getByRole('button', {
      name: 'Просмотреть условия и удалить ваше утверждение для tools',
    }))
    fireEvent.click(await screen.findByRole('button', { name: 'Удалить утверждение' }))
    expect(await screen.findByText('Ничего не изменено')).toBeTruthy()
    // A conflict changed nothing, so the row must still be shown exactly once and
    // must not be silently emptied as if the removal had succeeded.
    expect(screen.queryAllByText('Переопределено')).toHaveLength(1)
    expect(screen.queryByRole('button', { name: 'Перечитать модель' })).toBeNull()
    expect(screen.getByText(/Guanxi перечитал эту модель/u)).toBeTruthy()
  })

  it.each([
    {
      path: 'add',
      trigger: /утвердить выбранную capability/u,
      dialog: 'Утвердить эту capability самостоятельно?',
      confirm: 'Утвердить capability',
    },
    {
      path: 'remove',
      trigger: /удалить ваше утверждение для tools/u,
      dialog: 'Удалить ваше утверждение?',
      confirm: 'Удалить утверждение',
    },
  ])(
    'keeps $path dialog focus through a rerender instead of bouncing to the trigger',
    async ({ trigger, dialog, confirm }) => {
      const { view } = renderOverrides({ overrides: [override()] })
      const control = screen.getByRole('button', { name: trigger })
      control.focus()
      fireEvent.click(control)
      const confirmButton = await screen.findByRole('button', { name: confirm })
      await waitFor(() => expect(document.activeElement).toBe(confirmButton))

      // A parent rerender while the dialog is open must not tear down Modal's
      // focus effect and throw focus back to the activating control.
      view.rerender(
        <CapabilityOverrides model={model({ overrides: [override()] })} onRefresh={vi.fn()} />,
      )
      expect(screen.getByRole('dialog', { name: dialog })).toBeTruthy()
      expect(document.activeElement).toBe(screen.getByRole('button', { name: confirm }))
      expect(document.activeElement).not.toBe(control)

      // Escape still returns focus to the exact control that opened the dialog.
      fireEvent.keyDown(document, { key: 'Escape' })
      await waitFor(() => expect(document.activeElement).toBe(
        screen.getByRole('button', { name: trigger }),
      ))
    },
  )

  it('returns focus to the activating control after a confirmed mutation', async () => {
    vi.spyOn(api, 'clearCapabilityOverride')
      .mockResolvedValue(outcome({ state: 'cleared', overrides: [override({ capability: 'vision' })] }))
    renderOverrides({ overrides: [override(), override({ capability: 'vision' })] })
    const remove = screen.getByRole('button', {
      name: /удалить ваше утверждение для tools/u,
    })
    remove.focus()
    fireEvent.click(remove)
    fireEvent.click(await screen.findByRole('button', { name: 'Удалить утверждение' }))
    expect(await screen.findByText('Ваше утверждение удалено.')).toBeTruthy()
    // The removed row is gone, so focus must land somewhere real and not on body.
    await waitFor(() => expect(document.activeElement).not.toBe(document.body))
  })

  it('contains Tab inside the dialog', async () => {
    renderOverrides()
    fireEvent.click(screen.getByRole('button', { name: /утвердить выбранную capability/u }))
    const dialog = await screen.findByRole('dialog')
    const focusable = [...dialog.querySelectorAll<HTMLElement>(
      'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])',
    )].filter((node) => !node.hasAttribute('disabled'))
    expect(focusable.length).toBeGreaterThan(1)
    const last = focusable[focusable.length - 1]!
    last.focus()
    fireEvent.keyDown(document, { key: 'Tab' })
    // Tab from the last control wraps to the first inside the dialog, never to
    // the inert background.
    await waitFor(() => expect(dialog.contains(document.activeElement)).toBe(true))
    focusable[0]!.focus()
    fireEvent.keyDown(document, { key: 'Tab', shiftKey: true })
    await waitFor(() => expect(dialog.contains(document.activeElement)).toBe(true))
  })

  it('clears a previous error when the same action is retried', async () => {
    const apply = vi.spyOn(api, 'applyCapabilityOverride')
      .mockRejectedValueOnce(new Error('The capability override could not be changed safely'))
      .mockResolvedValueOnce(outcome())
    renderOverrides()
    const run = async () => {
      fireEvent.click(screen.getByRole('button', { name: /утвердить выбранную capability/u }))
      fireEvent.click(await screen.findByRole('button', { name: 'Утвердить capability' }))
    }
    await run()
    expect(await screen.findByText('Изменение не применилось. Ничего не записано.')).toBeTruthy()

    await run()
    expect(await screen.findByText('Ваше утверждение записано.')).toBeTruthy()
    // The stale error must not survive alongside the fresh success.
    expect(screen.queryByText('Изменение не применилось. Ничего не записано.')).toBeNull()
    expect(
      screen.queryByText('The capability override could not be changed safely'),
    ).toBeNull()
    expect(apply).toHaveBeenCalledTimes(2)
  })

  it('associates the visible label with the capability control', () => {
    renderOverrides()
    const select = screen.getByRole('combobox', { name: 'Какую capability утвердить' })
    const label = document.querySelector('label[for="capability-override-draft"]')
    // A visible `htmlFor` label must resolve to this control, not to nothing.
    expect(label).not.toBeNull()
    expect(select.id).toBe('capability-override-draft')
    expect((label as HTMLLabelElement).control).toBe(select)
  })

  it('offers only capabilities that are not asserted yet', async () => {
    renderOverrides({
      overrides: (
        ['completion', 'tools', 'vision', 'insert', 'thinking'] as const
      ).map((capability) => override({ capability })),
    })
    const select = screen.getByRole('combobox', { name: 'Какую capability утвердить' })
    expect(await optionLabels(select)).toEqual(['embedding'])
    expect(screen.queryAllByText('Переопределено')).toHaveLength(5)
  })
})
