import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Project, QuickRun } from '@alamo/contract'
import { QuickRunsPage } from '../../src/features/quick-runs/QuickRunsPage.tsx'
import { api } from '../../src/lib/api.ts'
import { setActiveLocale } from '../../src/lib/locale.ts'

const AT = '2026-08-13T10:00:00.000Z'
const ID = '11111111-1111-4111-8111-111111111111'
const PROJECT: Project = {
  id: 'project-1',
  name: 'Exact Project',
  createdAt: AT,
  updatedAt: AT,
  filesystemBindings: [],
}

function quickRun(
  policy: 'ttl' | 'keep' | 'session' = 'ttl',
  projectId: string | null = null,
): QuickRun {
  return {
    quickRunVersion: 1,
    id: ID,
    operation: 'complete',
    scope: projectId === null ? 'projectless' : 'project',
    projectId,
    createdAt: AT,
    updatedAt: AT,
    retention: {
      retentionVersion: 1,
      policy: policy === 'ttl' ? { mode: 'ttl', expiresAfterDays: 7 } : { mode: policy },
      policySource: policy === 'ttl' ? 'default' : 'user',
      policyUpdatedAt: AT,
      expiryCalculation: 'not_implemented',
      automaticCleanup: 'not_implemented',
      sessionEnforcement: 'not_implemented',
    },
    execution: { state: 'not_implemented', jobId: null, artifactCount: 0 },
  }
}

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })
  return { promise, resolve, reject }
}

afterEach(() => {
  vi.restoreAllMocks()
  setActiveLocale('ru')
})

describe('QuickRunsPage', () => {
  it('distinguishes loading, focused error/retry and exact empty state', async () => {
    vi.spyOn(api, 'listProjects').mockResolvedValue({ projects: [] })
    const second = deferred<{
      quickRunVersion: 1
      scope: 'projectless'
      projectId: null
      quickRuns: QuickRun[]
    }>()
    vi.spyOn(api, 'listQuickRuns')
      .mockRejectedValueOnce(new Error('safe Quick Run list failure'))
      .mockReturnValueOnce(second.promise)

    render(<QuickRunsPage />)
    expect(screen.getByRole('status', { name: 'Загружаем Quick Run' })).toBeTruthy()
    const error = await screen.findByRole('heading', { name: 'Не удалось загрузить Quick Run' })
    await waitFor(() => expect(error).toBe(document.activeElement))
    expect(screen.getByRole('alert').textContent).toContain('safe Quick Run list failure')

    fireEvent.click(screen.getByRole('button', { name: 'Повторить' }))
    await act(async () => second.resolve({
      quickRunVersion: 1,
      scope: 'projectless',
      projectId: null,
      quickRuns: [],
    }))
    expect(await screen.findByText('В этой области нет Quick Run')).toBeTruthy()
    expect(screen.getByText('Quick Run: 0')).toBeTruthy()
    expect(api.listQuickRuns).toHaveBeenCalledTimes(2)
  })

  it('creates exact Project metadata once, stays truthful and uses English fallback', async () => {
    setActiveLocale('en')
    const animationFrame = vi.spyOn(window, 'requestAnimationFrame')
      .mockImplementation((callback) => {
        callback(0)
        return 1
      })
    vi.spyOn(api, 'listProjects').mockResolvedValue({ projects: [PROJECT] })
    vi.spyOn(api, 'listQuickRuns').mockImplementation(async (query) => ({
      quickRunVersion: 1,
      scope: query.scope,
      projectId: query.scope === 'project' ? query.projectId : null,
      quickRuns: [],
    }))
    const creation = deferred<QuickRun>()
    vi.spyOn(api, 'createQuickRun').mockReturnValue(creation.promise)

    render(<QuickRunsPage />)
    expect(await screen.findByRole('heading', { name: 'Quick Run' })).toBeTruthy()
    expect(screen.getByText('Metadata is ready; execution is not')).toBeTruthy()
    const scope = screen.getByRole('combobox', { name: 'Scope' })
    fireEvent.change(scope, { target: { value: PROJECT.id } })
    await screen.findByText('Exact Project')

    const create = screen.getByRole('button', { name: 'Create metadata' })
    const form = create.closest('form')!
    fireEvent.submit(form)
    fireEvent.submit(form)
    expect(api.createQuickRun).toHaveBeenCalledTimes(1)
    expect(api.createQuickRun).toHaveBeenCalledWith({
      quickRunVersion: 1,
      operation: 'complete',
      scope: 'project',
      projectId: PROJECT.id,
    })
    await act(async () => creation.resolve(quickRun('ttl', PROJECT.id)))
    expect(await screen.findByText('1 Quick Run(s)')).toBeTruthy()
    await waitFor(() => expect(create).toBe(document.activeElement))
    expect(screen.getAllByText('Execution not implemented')).toHaveLength(1)
    expect(screen.getAllByText('Not implemented')).toHaveLength(3)
    expect(screen.queryByRole('button', { name: /save|run|execute/iu })).toBeNull()
    expect(screen.queryByText(/thread/iu)).toBeNull()
    animationFrame.mockRestore()
  })

  it('coalesces retention mutation, focuses failure and retries the exact policy without Save', async () => {
    vi.spyOn(api, 'listProjects').mockResolvedValue({ projects: [] })
    vi.spyOn(api, 'listQuickRuns').mockResolvedValue({
      quickRunVersion: 1,
      scope: 'projectless',
      projectId: null,
      quickRuns: [quickRun()],
    })
    const first = deferred<QuickRun>()
    vi.spyOn(api, 'updateQuickRunRetention')
      .mockReturnValueOnce(first.promise)
      .mockResolvedValueOnce(quickRun('session'))

    render(<QuickRunsPage />)
    await screen.findByText(ID)
    const session = screen.getByRole('button', { name: 'Сессия' })
    fireEvent.click(session)
    fireEvent.click(session)
    expect(api.updateQuickRunRetention).toHaveBeenCalledTimes(1)
    await act(async () => first.reject(new Error('safe retention mutation failure')))
    const alert = await screen.findByRole('alert')
    expect(alert.textContent).toContain('safe retention mutation failure')
    await waitFor(() => expect(alert).toBe(document.activeElement))

    fireEvent.click(screen.getByRole('button', { name: 'Повторить изменение retention' }))
    await waitFor(() => expect(api.updateQuickRunRetention).toHaveBeenCalledTimes(2))
    expect(api.updateQuickRunRetention).toHaveBeenNthCalledWith(1, ID, {
      quickRunVersion: 1,
      retentionVersion: 1,
      scope: 'projectless',
      policy: { mode: 'session' },
    })
    expect(api.updateQuickRunRetention).toHaveBeenNthCalledWith(2, ID, {
      quickRunVersion: 1,
      retentionVersion: 1,
      scope: 'projectless',
      policy: { mode: 'session' },
    })
    expect(await screen.findByText('Выбор пользователя')).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Сессия' }).getAttribute('aria-pressed')).toBe('true')
    expect(screen.queryByRole('button', { name: /save/iu })).toBeNull()
  })
})
