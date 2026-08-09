import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import type { Project } from '@alamo/contract'
import { ProjectsPage } from '../../src/features/projects/ProjectsPage.tsx'
import { api } from '../../src/lib/api.ts'

const PROJECT: Project = {
  id: 'project-1',
  name: 'Logical Project',
  createdAt: '2026-08-09T10:00:00.000Z',
  updatedAt: '2026-08-09T10:00:00.000Z',
  filesystemBindings: [],
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

describe('ProjectsPage', () => {
  it('distinguishes loading and empty state without showing a filesystem picker', async () => {
    const request = deferred<{ projects: Project[] }>()
    vi.spyOn(api, 'listProjects').mockReturnValue(request.promise)

    render(<ProjectsPage />)
    expect(screen.getByRole('status', { name: 'Загружаем проекты' })).toBeTruthy()

    await act(async () => request.resolve({ projects: [] }))
    expect(await screen.findByText('Проектов пока нет')).toBeTruthy()
    expect(
      screen.getByText('Название — редактируемые метаданные, его можно изменить позже.'),
    ).toBeTruthy()
    expect(screen.queryByLabelText(/пап|path|root/iu)).toBeNull()
    expect(screen.getByRole('textbox', { name: 'Название проекта' })).toBeTruthy()
  })

  it('focuses a contained error and retries into the empty projection', async () => {
    vi.spyOn(api, 'listProjects')
      .mockRejectedValueOnce(new Error('safe list failure'))
      .mockResolvedValue({ projects: [] })

    render(<ProjectsPage />)
    const heading = await screen.findByRole('heading', { name: 'Не удалось загрузить проекты' })
    expect(heading).toBe(document.activeElement)
    expect(screen.getByRole('alert').textContent).toContain('safe list failure')

    fireEvent.click(screen.getByRole('button', { name: 'Повторить' }))
    expect(await screen.findByText('Проектов пока нет')).toBeTruthy()
    expect(api.listProjects).toHaveBeenCalledTimes(2)
  })

  it('creates at most once under repeated form activation and refreshes the list', async () => {
    vi.spyOn(api, 'listProjects')
      .mockResolvedValueOnce({ projects: [] })
      .mockResolvedValue({ projects: [PROJECT] })
    const creation = deferred<Project>()
    vi.spyOn(api, 'createProject').mockReturnValue(creation.promise)

    render(<ProjectsPage />)
    const input = await screen.findByRole('textbox', { name: 'Название проекта' })
    fireEvent.change(input, { target: { value: '  Logical Project  ' } })
    const form = screen.getByRole('button', { name: 'Создать проект' }).closest('form')!
    fireEvent.submit(form)
    fireEvent.submit(form)

    expect(api.createProject).toHaveBeenCalledTimes(1)
    expect(api.createProject).toHaveBeenCalledWith({ name: 'Logical Project' })
    await act(async () => creation.resolve(PROJECT))
    expect(await screen.findByDisplayValue('Logical Project')).toBeTruthy()
    expect(api.listProjects).toHaveBeenCalledTimes(2)
  })

  it('renames Project metadata through the typed client and keeps English fallback curated', async () => {
    document.documentElement.lang = 'fr'
    vi.spyOn(api, 'listProjects').mockResolvedValue({ projects: [PROJECT] })
    vi.spyOn(api, 'updateProject').mockResolvedValue({ ...PROJECT, name: 'Renamed' })

    render(<ProjectsPage />)
    expect(await screen.findByRole('heading', { name: 'Projects' })).toBeTruthy()
    const input = screen.getByRole('textbox', { name: 'Rename — Logical Project' })
    fireEvent.change(input, { target: { value: 'Renamed' } })
    fireEvent.submit(input.closest('form')!)

    await waitFor(() => expect(api.updateProject).toHaveBeenCalledWith('project-1', { name: 'Renamed' }))
  })
})
