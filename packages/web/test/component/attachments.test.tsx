import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ArtifactTransferPolicy, Attachment, Project } from '@alamo/contract'
import { AttachmentsPage } from '../../src/features/attachments/AttachmentsPage.tsx'
import { api } from '../../src/lib/api.ts'

const AT = '2026-08-14T14:00:00.000Z'
const ID = '11111111-1111-4111-8111-111111111111'
const LEGACY_PROJECT: Project = {
  id: 'legacy-project-id',
  name: 'Legacy Project',
  createdAt: AT,
  updatedAt: AT,
  filesystemBindings: [],
}

const POLICY: ArtifactTransferPolicy = {
  policyVersion: 1,
  state: 'enabled',
  source: 'server_default_storage_policy',
  observedAt: AT,
  maxBytes: 32,
  maxActiveTransfers: 1,
  maxQueuedTransfers: 8,
  rangeRequests: 'unsupported',
  modelCapability: 'not_applicable',
  reason: null,
}

function attachment(projectId: string | null = null): Attachment {
  return {
    attachmentVersion: 1,
    artifact: {
      artifactVersion: 1,
      id: ID,
      kind: 'file',
      mediaType: 'text/plain',
      byteSize: 5,
      checksum: `sha256:${'a'.repeat(64)}`,
      ownership: projectId === null
        ? { scope: 'projectless' }
        : { scope: 'project', projectId },
      source: { jobId: null, parentArtifactId: null },
      retention: { mode: 'keep' },
      reference: { state: 'referenced' },
      gc: { state: 'not_implemented' },
      createdAt: AT,
    },
    displayName: 'exact.txt',
    modelConsumption: { state: 'not_connected', reason: 'attachment_transport_only' },
    export: { state: 'available', rangeRequests: 'unsupported' },
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

function listResponse(items: Attachment[] = [], projectId: string | null = null) {
  return {
    attachmentVersion: 1 as const,
    scope: projectId === null ? 'projectless' as const : 'project' as const,
    projectId,
    attachments: items,
    limit: 50,
    truncated: false,
  }
}

afterEach(() => {
  vi.restoreAllMocks()
  document.documentElement.lang = 'ru'
})

describe('AttachmentsPage', () => {
  it('shows observed policy, focused list error/retry and exact empty state', async () => {
    vi.spyOn(api, 'listProjects').mockResolvedValue({ projects: [] })
    vi.spyOn(api, 'artifactTransferPolicy').mockResolvedValue(POLICY)
    vi.spyOn(api, 'listAttachments')
      .mockRejectedValueOnce(new Error('safe attachment list failure'))
      .mockResolvedValueOnce(listResponse())

    render(<AttachmentsPage />)
    expect(screen.getByRole('status', { name: 'Загружаем вложения' })).toBeTruthy()
    expect(await screen.findByText(/^32.*Б$/u)).toBeTruthy()
    expect(screen.getByText(/ресурсная policy сервера/u)).toBeTruthy()
    const heading = await screen.findByRole('heading', { name: 'Не удалось загрузить вложения' })
    await waitFor(() => expect(heading).toBe(document.activeElement))
    expect(screen.getByRole('alert').textContent).toContain('safe attachment list failure')
    fireEvent.click(screen.getByRole('button', { name: 'Повторить' }))
    expect(await screen.findByText('В этой области нет вложений')).toBeTruthy()
    expect(screen.getByText('Вложений: 0')).toBeTruthy()
    expect(api.listAttachments).toHaveBeenCalledTimes(2)
  })

  it('retries a lost response with one UUID and renders one legacy-Project item', async () => {
    vi.spyOn(crypto, 'randomUUID').mockReturnValue('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa')
    vi.spyOn(api, 'listProjects').mockResolvedValue({ projects: [LEGACY_PROJECT] })
    vi.spyOn(api, 'artifactTransferPolicy').mockResolvedValue(POLICY)
    vi.spyOn(api, 'listAttachments').mockImplementation(async (scope) => (
      scope.scope === 'project'
        ? listResponse([], scope.projectId)
        : listResponse()
    ))
    const first = deferred<Attachment>()
    vi.spyOn(api, 'uploadAttachment')
      .mockReturnValueOnce(first.promise)
      .mockResolvedValueOnce(attachment(LEGACY_PROJECT.id))

    render(<AttachmentsPage />)
    await screen.findByText('В этой области нет вложений')
    fireEvent.change(screen.getByRole('combobox', { name: 'Область' }), {
      target: { value: LEGACY_PROJECT.id },
    })
    await screen.findByRole('heading', { name: LEGACY_PROJECT.name })
    const file = new File(['exact'], 'exact.txt', { type: 'text/plain' })
    fireEvent.change(screen.getByLabelText('Выберите или перетащите один локальный файл'), {
      target: { files: [file] },
    })
    const upload = screen.getByRole('button', { name: 'Загрузить вложение' })
    fireEvent.click(upload)
    fireEvent.click(upload)
    expect(api.uploadAttachment).toHaveBeenCalledTimes(1)
    await act(async () => first.reject(new Error('lost upload response')))
    const error = await screen.findByRole('alert')
    expect(error.textContent).toContain('lost upload response')
    fireEvent.click(screen.getByRole('button', { name: 'Повторить тот же upload intent' }))
    await waitFor(() => expect(api.uploadAttachment).toHaveBeenCalledTimes(2))
    const calls = vi.mocked(api.uploadAttachment).mock.calls
    expect(calls[0]?.[2]).toBe('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa')
    expect(calls[1]?.[2]).toBe('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa')
    expect(await screen.findAllByText('exact.txt')).toHaveLength(1)
    expect(screen.getAllByText(ID)).toHaveLength(1)
    expect(screen.getAllByText(/Не добавлено в контекст модели/u)).toHaveLength(1)
    expect(screen.queryByRole('button', { name: /отправить|запустить|execute/iu })).toBeNull()
    await waitFor(() => expect(
      screen.getByLabelText('Выберите или перетащите один локальный файл'),
    ).toBe(document.activeElement))
  })

  it('cancels one active upload, keeps intent for retry and returns focus', async () => {
    vi.spyOn(api, 'listProjects').mockResolvedValue({ projects: [] })
    vi.spyOn(api, 'artifactTransferPolicy').mockResolvedValue(POLICY)
    vi.spyOn(api, 'listAttachments').mockResolvedValue(listResponse())
    vi.spyOn(api, 'uploadAttachment')
    vi.spyOn(api, 'uploadAttachment').mockImplementation(
      async (_scope, _file, _intent, signal) => new Promise<Attachment>((_resolve, reject) => {
        signal?.addEventListener('abort', () => reject(new DOMException('cancelled', 'AbortError')), { once: true })
      }),
    )

    render(<AttachmentsPage />)
    await screen.findByText('В этой области нет вложений')
    fireEvent.change(screen.getByLabelText('Выберите или перетащите один локальный файл'), {
      target: { files: [new File(['exact'], 'exact.txt', { type: 'text/plain' })] },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Загрузить вложение' }))
    expect(await screen.findByRole('progressbar', { name: 'Идёт загрузка вложения' })).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Отменить загрузку' }))
    expect(await screen.findByText('Загрузка вложения отменена.')).toBeTruthy()
    const retry = screen.getByRole('button', { name: 'Повторить тот же upload intent' })
    expect(retry).toBeTruthy()
    await waitFor(() => expect(retry).toBe(document.activeElement))
  })

  it('rejects unsafe/over-policy files locally and keeps English fallback', async () => {
    document.documentElement.lang = 'fr'
    vi.spyOn(api, 'listProjects').mockResolvedValue({ projects: [] })
    vi.spyOn(api, 'artifactTransferPolicy').mockResolvedValue(POLICY)
    vi.spyOn(api, 'listAttachments').mockResolvedValue(listResponse())
    vi.spyOn(api, 'uploadAttachment')
    render(<AttachmentsPage />)
    await screen.findByText('No attachments in this scope')
    const input = screen.getByLabelText('Choose or drop one local file')
    fireEvent.drop(input.closest('.attachment-drop')!, {
      dataTransfer: { files: [new File(['safe'], 'dropped.txt', { type: 'text/plain' })] },
    })
    expect(screen.getByText(/dropped\.txt/u)).toBeTruthy()
    fireEvent.change(input, {
      target: { files: [new File(['x'], '../unsafe', { type: 'text/plain' })] },
    })
    expect(screen.getByRole('alert').textContent).toContain('filename contains a path')
    fireEvent.change(input, {
      target: { files: [new File(['x'.repeat(33)], 'large.txt', { type: 'text/plain' })] },
    })
    expect(screen.getByRole('alert').textContent).toContain('exceeds the observed server policy')
    expect(api.uploadAttachment).not.toHaveBeenCalled()
  })
})
