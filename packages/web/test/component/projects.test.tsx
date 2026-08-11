import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  PROJECT_ICON_MANIFEST,
  PROJECT_PRESENTATION_VERSION,
  type ProjectWithPresentation,
} from '@alamo/contract'
import { ProjectsPage } from '../../src/features/projects/ProjectsPage.tsx'
import { api } from '../../src/lib/api.ts'
import { translate, type LocaleKey } from '../../src/lib/locale.ts'

const PROJECT: ProjectWithPresentation = {
  id: 'project-1',
  name: 'Logical Project',
  createdAt: '2026-08-09T10:00:00.000Z',
  updatedAt: '2026-08-09T10:00:00.000Z',
  filesystemBindings: [],
  presentationVersion: PROJECT_PRESENTATION_VERSION,
  iconKey: 'folder',
  colorToken: 'slate',
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
  document.documentElement.lang = 'ru'
})

beforeEach(() => {
  vi.spyOn(api, 'listProjectChats').mockResolvedValue({
    ownershipVersion: 1,
    project: {
      id: PROJECT.id,
      name: PROJECT.name,
      createdAt: PROJECT.createdAt,
      updatedAt: PROJECT.updatedAt,
      filesystemBindings: [],
    },
    chats: [],
  })
})

describe('ProjectsPage', () => {
  it('provides a curated English and Russian accessible name for every manifest icon', () => {
    document.documentElement.lang = 'en'
    const english = PROJECT_ICON_MANIFEST.map((icon) => translate(icon.nameKey as LocaleKey))
    document.documentElement.lang = 'ru'
    const russian = PROJECT_ICON_MANIFEST.map((icon) => translate(icon.nameKey as LocaleKey))
    expect(english).toHaveLength(48)
    expect(russian).toHaveLength(48)
    PROJECT_ICON_MANIFEST.forEach((icon, index) => {
      expect(english[index]).not.toBe(icon.nameKey)
      expect(russian[index]).not.toBe(icon.nameKey)
      expect(russian[index]).not.toBe(english[index])
    })
  })

  it('distinguishes loading and empty state without showing a filesystem picker', async () => {
    const request = deferred<{
      presentationVersion: typeof PROJECT_PRESENTATION_VERSION
      projects: ProjectWithPresentation[]
    }>()
    vi.spyOn(api, 'listProjectsWithPresentation').mockReturnValue(request.promise)

    render(<ProjectsPage />)
    expect(screen.getByRole('status', { name: 'Загружаем проекты' })).toBeTruthy()

    await act(async () => request.resolve({ presentationVersion: 1, projects: [] }))
    expect(await screen.findByText('Проектов пока нет')).toBeTruthy()
    expect(
      screen.getByText('Название — редактируемые метаданные, его можно изменить позже.'),
    ).toBeTruthy()
    expect(screen.queryByLabelText(/пап|path|root/iu)).toBeNull()
    expect(screen.getByRole('textbox', { name: 'Название проекта' })).toBeTruthy()
  })

  it('focuses a contained error and retries into the empty projection', async () => {
    vi.spyOn(api, 'listProjectsWithPresentation')
      .mockRejectedValueOnce(new Error('safe list failure'))
      .mockResolvedValue({ presentationVersion: 1, projects: [] })

    render(<ProjectsPage />)
    const heading = await screen.findByRole('heading', { name: 'Не удалось загрузить проекты' })
    expect(heading).toBe(document.activeElement)
    expect(screen.getByRole('alert').textContent).toContain('safe list failure')

    fireEvent.click(screen.getByRole('button', { name: 'Повторить' }))
    expect(await screen.findByText('Проектов пока нет')).toBeTruthy()
    expect(api.listProjectsWithPresentation).toHaveBeenCalledTimes(2)
  })

  it('creates at most once under repeated form activation and refreshes the list', async () => {
    vi.spyOn(api, 'listProjectsWithPresentation')
      .mockResolvedValueOnce({ presentationVersion: 1, projects: [] })
      .mockResolvedValue({ presentationVersion: 1, projects: [PROJECT] })
    const creation = deferred<Omit<ProjectWithPresentation, 'presentationVersion' | 'iconKey' | 'colorToken'>>()
    vi.spyOn(api, 'createProject').mockReturnValue(creation.promise)

    render(<ProjectsPage />)
    const input = await screen.findByRole('textbox', { name: 'Название проекта' })
    fireEvent.change(input, { target: { value: '  Logical Project  ' } })
    const form = screen.getByRole('button', { name: 'Создать проект' }).closest('form')!
    fireEvent.submit(form)
    fireEvent.submit(form)

    expect(api.createProject).toHaveBeenCalledTimes(1)
    expect(api.createProject).toHaveBeenCalledWith({ name: 'Logical Project' })
    await act(async () => creation.resolve({
      id: PROJECT.id,
      name: PROJECT.name,
      createdAt: PROJECT.createdAt,
      updatedAt: PROJECT.updatedAt,
      filesystemBindings: [],
    }))
    expect(await screen.findByDisplayValue('Logical Project')).toBeTruthy()
    expect(api.listProjectsWithPresentation).toHaveBeenCalledTimes(2)
  })

  it('shows an exact bounded Chat group and contains error/retry per Project', async () => {
    vi.spyOn(api, 'listProjectsWithPresentation').mockResolvedValue({
      presentationVersion: 1,
      projects: [PROJECT],
    })
    vi.mocked(api.listProjectChats)
      .mockRejectedValueOnce(new Error('scoped list failed'))
      .mockResolvedValue({
        ownershipVersion: 1,
        project: {
          id: PROJECT.id,
          name: PROJECT.name,
          createdAt: PROJECT.createdAt,
          updatedAt: PROJECT.updatedAt,
          filesystemBindings: [],
        },
        chats: [
          {
            id: 'chat-newer',
            title: 'Newer Chat',
            mode: 'chat',
            model: 'model',
            workspaceId: null,
            options: { numCtx: 8192, temperature: 0.7, think: 'off' },
            createdAt: '2026-08-10T11:00:00.000Z',
            updatedAt: '2026-08-10T11:00:00.000Z',
            messageCount: 2,
            ownershipVersion: 1,
            projectId: PROJECT.id,
          },
          {
            id: 'chat-older',
            title: 'Older Chat',
            mode: 'chat',
            model: 'model',
            workspaceId: null,
            options: { numCtx: 8192, temperature: 0.7, think: 'off' },
            createdAt: '2026-08-10T10:00:00.000Z',
            updatedAt: '2026-08-10T10:00:00.000Z',
            messageCount: 0,
            ownershipVersion: 1,
            projectId: PROJECT.id,
          },
        ],
      })

    render(<ProjectsPage />)
    expect(await screen.findByText(/scoped list failed/u)).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Повторить' }))
    await screen.findByText('Newer Chat')
    const group = screen.getByRole('region', { name: 'Чаты проекта' })
    const links = Array.from(group.querySelectorAll('a'))
    expect(links.map((link) => link.textContent)).toEqual([
      'Новый чат',
      'Newer ChatСообщений: 2',
      'Older ChatСообщений: 0',
    ])
    expect(api.listProjectChats).toHaveBeenCalledTimes(2)
  })

  it('renames Project metadata through the typed client and keeps English fallback curated', async () => {
    document.documentElement.lang = 'fr'
    vi.spyOn(api, 'listProjectsWithPresentation').mockResolvedValue({
      presentationVersion: 1,
      projects: [PROJECT],
    })
    vi.spyOn(api, 'updateProject').mockResolvedValue({ ...PROJECT, name: 'Renamed' })

    render(<ProjectsPage />)
    expect(await screen.findByRole('heading', { name: 'Projects' })).toBeTruthy()
    const input = screen.getByRole('textbox', { name: 'Rename — Logical Project' })
    fireEvent.change(input, { target: { value: 'Renamed' } })
    fireEvent.submit(input.closest('form')!)

    await waitFor(() => expect(api.updateProject).toHaveBeenCalledWith('project-1', { name: 'Renamed' }))
  })

  it('keeps the canonical icon DOM bounded and supports search, category, grid and focus return', async () => {
    vi.spyOn(api, 'listProjectsWithPresentation').mockResolvedValue({
      presentationVersion: 1,
      projects: [PROJECT],
    })

    render(<ProjectsPage />)
    const trigger = await screen.findByRole('button', { name: 'Изменить оформление' })
    fireEvent.click(trigger)
    const search = screen.getByRole('textbox', { name: 'Поиск иконок' })
    expect(search).toBe(document.activeElement)
    expect(screen.getAllByRole('gridcell')).toHaveLength(12)
    expect(screen.getAllByRole('row')).toHaveLength(3)
    expect(screen.getByText('Страница иконок 1 из 4')).toBeTruthy()

    const folder = screen.getByRole('gridcell', { name: 'Папка' })
    folder.focus()
    fireEvent.keyDown(folder, { key: 'ArrowRight' })
    await waitFor(() =>
      expect(screen.getByRole('gridcell', { name: 'Портфель' })).toBe(document.activeElement),
    )
    fireEvent.keyDown(document.activeElement!, { key: 'ArrowDown' })
    await waitFor(() =>
      expect(screen.getByRole('gridcell', { name: 'Флаг' })).toBe(document.activeElement),
    )
    fireEvent.keyDown(document.activeElement!, { key: 'ArrowLeft' })
    await waitFor(() =>
      expect(screen.getByRole('gridcell', { name: 'Закладка' })).toBe(document.activeElement),
    )
    fireEvent.keyDown(document.activeElement!, { key: 'ArrowUp' })
    await waitFor(() =>
      expect(screen.getByRole('gridcell', { name: 'Папка' })).toBe(document.activeElement),
    )
    fireEvent.keyDown(document.activeElement!, { key: 'End' })
    await waitFor(() =>
      expect(screen.getByRole('gridcell', { name: 'Ветка Git' })).toBe(document.activeElement),
    )
    fireEvent.keyDown(document.activeElement!, { key: 'Home' })
    await waitFor(() =>
      expect(screen.getByRole('gridcell', { name: 'Папка' })).toBe(document.activeElement),
    )
    fireEvent.keyDown(document.activeElement!, { key: 'End' })
    await waitFor(() =>
      expect(screen.getByRole('gridcell', { name: 'Ветка Git' })).toBe(document.activeElement),
    )
    fireEvent.keyDown(document.activeElement!, { key: 'PageDown' })
    await waitFor(() => expect(screen.getByText('Страница иконок 2 из 4')).toBeTruthy())
    expect(screen.getAllByRole('gridcell')).toHaveLength(12)

    fireEvent.change(search, { target: { value: 'микроскоп' } })
    expect(screen.getAllByRole('gridcell')).toHaveLength(1)
    expect(screen.getByRole('gridcell', { name: 'Микроскоп' })).toBeTruthy()
    fireEvent.change(search, { target: { value: 'нет-такой-иконки' } })
    expect(screen.queryAllByRole('gridcell')).toHaveLength(0)
    expect(screen.getByText('Для этого поиска и категории иконок не найдено.')).toBeTruthy()

    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' })
    expect(screen.queryByRole('dialog')).toBeNull()
    await waitFor(() => expect(trigger).toBe(document.activeElement))
  })

  it('selects icon and color and sends one versioned mutation under repeated Save activation', async () => {
    vi.spyOn(api, 'listProjectsWithPresentation').mockResolvedValue({
      presentationVersion: 1,
      projects: [PROJECT],
    })
    const mutation = deferred<ProjectWithPresentation>()
    vi.spyOn(api, 'updateProjectPresentation').mockReturnValue(mutation.promise)

    render(<ProjectsPage />)
    const trigger = await screen.findByRole('button', { name: 'Изменить оформление' })
    fireEvent.click(trigger)
    fireEvent.click(screen.getByRole('gridcell', { name: 'Ракета' }))
    fireEvent.click(screen.getByRole('radio', { name: 'Синий' }))
    const save = screen.getByRole('button', { name: 'Сохранить оформление' })
    const form = save.closest('form')!
    fireEvent.submit(form)
    fireEvent.submit(form)

    expect(api.updateProjectPresentation).toHaveBeenCalledTimes(1)
    expect(api.updateProjectPresentation).toHaveBeenCalledWith('project-1', {
      presentationVersion: 1,
      iconKey: 'rocket',
      colorToken: 'blue',
    })
    await act(async () => mutation.resolve({
      ...PROJECT,
      iconKey: 'rocket',
      colorToken: 'blue',
      updatedAt: '2026-08-10T10:00:00.000Z',
    }))
    expect(screen.queryByRole('dialog')).toBeNull()
    await waitFor(() => expect(trigger).toBe(document.activeElement))
  })

  it('keeps a failed save contained and retries only after a new activation', async () => {
    vi.spyOn(api, 'listProjectsWithPresentation').mockResolvedValue({
      presentationVersion: 1,
      projects: [PROJECT],
    })
    vi.spyOn(api, 'updateProjectPresentation')
      .mockRejectedValueOnce(new Error('safe presentation failure'))
      .mockResolvedValue({ ...PROJECT, iconKey: 'star' })

    render(<ProjectsPage />)
    const trigger = await screen.findByRole('button', { name: 'Изменить оформление' })
    fireEvent.click(trigger)
    fireEvent.click(screen.getByRole('gridcell', { name: 'Звезда' }))
    fireEvent.click(screen.getByRole('button', { name: 'Сохранить оформление' }))
    expect(await screen.findByText('Не удалось сохранить оформление')).toBeTruthy()
    expect(screen.getByRole('alert').textContent).toContain('safe presentation failure')
    expect(api.updateProjectPresentation).toHaveBeenCalledTimes(1)

    fireEvent.click(screen.getByRole('button', { name: 'Сохранить оформление' }))
    await waitFor(() => expect(api.updateProjectPresentation).toHaveBeenCalledTimes(2))
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
  })
})
