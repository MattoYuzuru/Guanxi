/**
 * Роуты рабочих директорий и обзор файловой системы для пикера.
 *
 * Обзор нужен, потому что фронт не имеет доступа к файловой системе — и не должен
 * его иметь. Все пути живут на сервере; клиент оперирует идентификаторами воркспейсов.
 * Благодаря этому тот же интерфейс будет работать, когда сервер уедет на другую машину.
 *
 * ВНИМАНИЕ при выносе наружу: этот роут показывает дерево директорий хоста.
 * В удалённом режиме его нужно ограничить списком разрешённых корней и закрыть
 * аутентификацией.
 */
import { readdir, stat } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { Hono } from 'hono'
import { createWorkspaceBody } from '@guanxi/contract'
import type { AppContext } from '../context.ts'
import { notFound } from './errors.ts'

const MAX_BROWSE_ENTRIES = 300

export function workspacesRoutes(app: AppContext): Hono {
  const routes = new Hono()

  routes.get('/', (context) => context.json({ workspaces: app.workspaces.list() }))

  /** Обзор директорий. Порядок важен: должен стоять до `/:id`. */
  routes.get('/browse', async (context) => {
    const requested = context.req.query('path')
    const target = resolve(requested && requested.length > 0 ? requested : homedir())

    if (!existsSync(target)) {
      return notFound(context, 'workspace_not_found', `Путь не найден: ${target}`)
    }

    const info = await stat(target).catch(() => null)
    if (!info?.isDirectory()) {
      return context.json(
        { code: 'validation_failed', message: `${target} — не директория`, details: null },
        400,
      )
    }

    const raw = await readdir(target, { withFileTypes: true }).catch(() => [])

    const entries = await Promise.all(
      raw
        .filter((entry) => entry.isDirectory() && !entry.name.startsWith('.'))
        .slice(0, MAX_BROWSE_ENTRIES)
        .map(async (entry) => {
          const full = join(target, entry.name)
          return {
            name: entry.name,
            path: full,
            isDirectory: true,
            // Отметка репозитория помогает быстро найти нужный проект в списке.
            isGitRepo: existsSync(join(full, '.git')),
          }
        }),
    )

    entries.sort((a, b) => a.name.localeCompare(b.name, 'ru'))

    const parent = dirname(target)

    return context.json({
      path: target,
      parent: parent === target ? null : parent,
      entries,
    })
  })

  routes.post('/', async (context) => {
    const parsed = createWorkspaceBody.safeParse(await context.req.json().catch(() => null))
    if (!parsed.success) {
      return context.json({ code: 'validation_failed', message: 'Нужен rootPath', details: null }, 400)
    }

    try {
      return context.json(app.workspaces.create(parsed.data.rootPath, parsed.data.name), 201)
    } catch (error) {
      return context.json(
        {
          code: 'validation_failed',
          message: error instanceof Error ? error.message : String(error),
          details: null,
        },
        400,
      )
    }
  })

  routes.get('/:id', (context) => {
    const workspace = app.workspaces.get(context.req.param('id'))
    if (!workspace) return notFound(context, 'workspace_not_found', 'Рабочая директория не найдена')
    return context.json(workspace)
  })

  routes.delete('/:id', (context) => {
    if (!app.workspaces.delete(context.req.param('id'))) {
      return notFound(context, 'workspace_not_found', 'Рабочая директория не найдена')
    }
    return context.json({ ok: true })
  })

  return routes
}
