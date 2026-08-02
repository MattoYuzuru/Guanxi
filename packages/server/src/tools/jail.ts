/**
 * Ограничение файловых операций границами воркспейса.
 *
 * Это единственная преграда между агентом и остальным диском, поэтому проверка
 * идёт до операции, а не после, и опирается на `realpath`, а не на строковое
 * сравнение путей. Строкового сравнения недостаточно: симлинк внутри воркспейса
 * может указывать наружу, и текстово такой путь выглядит совершенно законным.
 *
 * Целевой файл может ещё не существовать — агент имеет право создавать файлы.
 * Поэтому раскрываем ближайшего существующего предка и проверяем уже его,
 * а несуществующий хвост приписываем обратно.
 */
import { realpathSync } from 'node:fs'
import { isAbsolute, resolve, sep } from 'node:path'

export class PathOutsideWorkspaceError extends Error {
  readonly requestedPath: string
  readonly workspaceRoot: string

  constructor(requestedPath: string, workspaceRoot: string) {
    super(`Путь вне воркспейса: ${requestedPath}`)
    this.name = 'PathOutsideWorkspaceError'
    this.requestedPath = requestedPath
    this.workspaceRoot = workspaceRoot
  }
}

/** Раскрывает симлинки у ближайшего существующего предка пути. */
function realpathOfNearestExisting(target: string): { real: string; missingTail: string[] } {
  const missingTail: string[] = []
  let current = resolve(target)

  while (true) {
    try {
      return { real: realpathSync(current), missingTail }
    } catch {
      const parent = resolve(current, '..')
      // Дошли до корня файловой системы и ничего не существует.
      if (parent === current) return { real: current, missingTail }

      const segment = current.slice(parent.length).replace(/^[\\/]+/, '')
      if (segment) missingTail.unshift(segment)
      current = parent
    }
  }
}

function isInside(child: string, root: string): boolean {
  if (child === root) return true
  // Разделитель обязателен: иначе /a/workspace2 пройдёт как «внутри» /a/work.
  return child.startsWith(root.endsWith(sep) ? root : root + sep)
}

/**
 * Приводит запрошенный путь к абсолютному внутри воркспейса.
 * Бросает `PathOutsideWorkspaceError`, если результат выходит за границы.
 *
 * @param workspaceRoot корень воркспейса (существующая директория)
 * @param requested путь от пользователя или модели: относительный или абсолютный
 */
export function resolveInWorkspace(workspaceRoot: string, requested: string): string {
  if (requested.includes('\0')) {
    throw new PathOutsideWorkspaceError(requested, workspaceRoot)
  }

  let rootReal: string
  try {
    rootReal = realpathSync(resolve(workspaceRoot))
  } catch {
    throw new Error(`Корень воркспейса недоступен: ${workspaceRoot}`)
  }

  const candidate = isAbsolute(requested) ? resolve(requested) : resolve(rootReal, requested)

  const { real, missingTail } = realpathOfNearestExisting(candidate)

  // Существующая часть пути обязана лежать внутри воркспейса.
  if (!isInside(real, rootReal)) {
    throw new PathOutsideWorkspaceError(requested, workspaceRoot)
  }

  const resolved = missingTail.length > 0 ? resolve(real, ...missingTail) : real

  /*
   * Несуществующий хвост тоже проверяем: он может содержать «..», уводящие наружу
   * (`newdir/../../../etc/passwd`), — resolve их схлопнет, а мы это заметим.
   */
  if (!isInside(resolved, rootReal)) {
    throw new PathOutsideWorkspaceError(requested, workspaceRoot)
  }

  return resolved
}

/** Путь относительно корня воркспейса — для показа в интерфейсе. */
export function relativeToWorkspace(workspaceRoot: string, absolutePath: string): string {
  const rootReal = (() => {
    try {
      return realpathSync(resolve(workspaceRoot))
    } catch {
      return resolve(workspaceRoot)
    }
  })()

  if (absolutePath === rootReal) return '.'
  if (isInside(absolutePath, rootReal)) return absolutePath.slice(rootReal.length + 1)
  return absolutePath
}
