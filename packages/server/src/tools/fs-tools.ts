/**
 * Файловые инструменты агента.
 *
 * Каждый путь проходит через `resolveInWorkspace` до операции — это единственная
 * преграда между агентом и остальным диском.
 *
 * Отдельная забота — объём вывода. Контекст локальной модели 8-32k токенов, и
 * один `cat` большого файла его исчерпает. Поэтому у всех инструментов есть
 * жёсткие лимиты, а урезание всегда обозначается явно, чтобы модель понимала,
 * что видит не весь файл.
 */
import { open, readFile, readdir, stat, mkdir, writeFile } from 'node:fs/promises'
import { dirname, join, relative } from 'node:path'
import { relativeToWorkspace, resolveInWorkspace } from './jail.ts'
import {
  ToolError,
  optionalNumber,
  optionalString,
  requireString,
  requireWorkspace,
  type ToolDefinition,
} from './types.ts'

/** Больше этого файл не читаем целиком — контекст дороже. */
const MAX_READ_BYTES = 256 * 1024
const MAX_READ_LINES = 2_000
const MAX_DIR_ENTRIES = 500
const MAX_GLOB_RESULTS = 300
const MAX_GREP_MATCHES = 200

/** Директории, которые не имеет смысла обходить: шум и десятки тысяч файлов. */
const IGNORED_DIRS = new Set([
  'node_modules',
  '.git',
  'dist',
  'build',
  'target',
  '.next',
  '.venv',
  'venv',
  '__pycache__',
  '.gradle',
  '.idea',
])

async function isBinary(path: string): Promise<boolean> {
  let handle: Awaited<ReturnType<typeof open>> | null = null
  try {
    handle = await open(path, 'r')
    const prefix = Buffer.alloc(1024)
    const { bytesRead } = await handle.read(prefix, 0, prefix.length, 0)
    // Нулевой байт в первом килобайте — надёжный признак двоичного файла.
    return prefix.subarray(0, bytesRead).includes(0)
  } catch {
    return false
  } finally {
    await handle?.close().catch(() => {})
  }
}

/** Читает не больше лимита даже для огромного файла. */
async function readPrefix(path: string, maxBytes: number): Promise<{
  text: string
  bytesRead: number
}> {
  const handle = await open(path, 'r')
  try {
    const buffer = Buffer.alloc(maxBytes)
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0)
    return { text: buffer.subarray(0, bytesRead).toString('utf8'), bytesRead }
  } finally {
    await handle.close()
  }
}

export const listDirTool: ToolDefinition = {
  name: 'list_dir',
  description:
    'Показать содержимое директории внутри рабочей папки. Возвращает файлы и подпапки с размерами.',
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'Путь относительно корня рабочей папки. По умолчанию — корень.' },
    },
  },
  mutating: false,
  needsWorkspace: true,
  async execute(args, context) {
    const root = requireWorkspace(context)
    const target = resolveInWorkspace(root, optionalString(args, 'path') ?? '.')

    const entries = await readdir(target, { withFileTypes: true }).catch(() => {
      throw new ToolError(`Не удалось прочитать директорию: ${relativeToWorkspace(root, target)}`)
    })

    const visible = entries
      .filter((entry) => !entry.name.startsWith('.') || entry.name === '.env.example')
      .slice(0, MAX_DIR_ENTRIES)

    const lines: string[] = []
    for (const entry of visible) {
      if (entry.isDirectory()) {
        lines.push(`${entry.name}/`)
        continue
      }
      const info = await stat(join(target, entry.name)).catch(() => null)
      lines.push(`${entry.name}${info ? ` (${info.size} Б)` : ''}`)
    }

    const truncated = entries.length > MAX_DIR_ENTRIES
    const header = `${relativeToWorkspace(root, target)}:`
    const footer = truncated ? `\n… показаны первые ${MAX_DIR_ENTRIES} из ${entries.length}` : ''

    return { content: `${header}\n${lines.join('\n') || '(пусто)'}${footer}` }
  },
}

export const readFileTool: ToolDefinition = {
  name: 'read_file',
  description:
    'Прочитать текстовый файл. Строки нумеруются. Для больших файлов используй offset и limit.',
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'Путь к файлу относительно корня рабочей папки' },
      offset: { type: 'number', description: 'С какой строки начать (с 1)' },
      limit: { type: 'number', description: 'Сколько строк прочитать' },
    },
    required: ['path'],
  },
  mutating: false,
  needsWorkspace: true,
  async execute(args, context) {
    const root = requireWorkspace(context)
    const target = resolveInWorkspace(root, requireString(args, 'path'))
    const shown = relativeToWorkspace(root, target)

    const info = await stat(target).catch(() => {
      throw new ToolError(`Файл не найден: ${shown}`)
    })
    if (info.isDirectory()) throw new ToolError(`${shown} — это директория, а не файл`)
    if (await isBinary(target)) throw new ToolError(`${shown} — двоичный файл, прочитать нельзя`)

    const { text: raw, bytesRead } = await readPrefix(target, MAX_READ_BYTES)
    const allLines = raw.split('\n')

    const offset = Math.max(1, Math.floor(optionalNumber(args, 'offset') ?? 1))
    const limit = Math.max(
      1,
      Math.min(Math.floor(optionalNumber(args, 'limit') ?? MAX_READ_LINES), MAX_READ_LINES),
    )
    const slice = allLines.slice(offset - 1, offset - 1 + limit)

    const numbered = slice.map((line, index) => `${offset + index}\t${line}`).join('\n')
    const shownUpTo = offset - 1 + slice.length
    const sourceTruncated = info.size > bytesRead
    const linesTruncated = shownUpTo < allLines.length
    const footer =
      sourceTruncated || linesTruncated
        ? `\n… показаны строки ${offset}-${shownUpTo}; следующая строка: offset=${shownUpTo + 1}` +
          (sourceTruncated
            ? `; файл больше безопасного лимита чтения ${MAX_READ_BYTES} Б`
            : ` из ${allLines.length}`)
        : ''

    return { content: `${shown}\n${numbered}${footer}` }
  },
}

export const writeFileTool: ToolDefinition = {
  name: 'write_file',
  description:
    'Создать файл или полностью перезаписать существующий. Для точечной правки используй edit_file.',
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'Путь к файлу относительно корня рабочей папки' },
      content: { type: 'string', description: 'Полное новое содержимое файла' },
    },
    required: ['path', 'content'],
  },
  mutating: true,
  needsWorkspace: true,
  async preview(args, context) {
    const root = requireWorkspace(context)
    const target = resolveInWorkspace(root, requireString(args, 'path'))
    const shown = relativeToWorkspace(root, target)

    const content = args['content']
    if (typeof content !== 'string') throw new ToolError('Аргумент «content» обязателен')

    const before = await readFile(target, 'utf8').catch(() => '')
    return { diff: { path: shown, before, after: content } }
  },
  async execute(args, context) {
    const preview = await writeFileTool.preview!(args, context)
    const root = requireWorkspace(context)
    const target = resolveInWorkspace(root, requireString(args, 'path'))
    const shown = relativeToWorkspace(root, target)
    const content = args['content'] as string

    await mkdir(dirname(target), { recursive: true })
    await writeFile(target, content, 'utf8')

    return {
      content: `Записано: ${shown} (${Buffer.byteLength(content, 'utf8')} Б)`,
      diff: preview.diff,
    }
  },
}

export const editFileTool: ToolDefinition = {
  name: 'edit_file',
  description:
    'Заменить фрагмент текста в файле. old_string должен встречаться ровно один раз — иначе правка отклоняется.',
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'Путь к файлу относительно корня рабочей папки' },
      old_string: { type: 'string', description: 'Точный текст, который надо заменить' },
      new_string: { type: 'string', description: 'Текст замены' },
    },
    required: ['path', 'old_string', 'new_string'],
  },
  mutating: true,
  needsWorkspace: true,
  async preview(args, context) {
    const root = requireWorkspace(context)
    const target = resolveInWorkspace(root, requireString(args, 'path'))
    const shown = relativeToWorkspace(root, target)

    const oldString = requireString(args, 'old_string')
    const newString = args['new_string']
    if (typeof newString !== 'string') throw new ToolError('Аргумент «new_string» обязателен')

    const before = await readFile(target, 'utf8').catch(() => {
      throw new ToolError(`Файл не найден: ${shown}`)
    })

    const occurrences = before.split(oldString).length - 1
    if (occurrences === 0) throw new ToolError(`Текст для замены не найден в ${shown}`)
    if (occurrences > 1) {
      throw new ToolError(
        `Текст встречается в ${shown} ${occurrences} раз — уточни old_string, добавив окружающие строки`,
      )
    }

    const after = before.replace(oldString, newString)
    return { diff: { path: shown, before, after } }
  },
  async execute(args, context) {
    const preview = await editFileTool.preview!(args, context)
    const root = requireWorkspace(context)
    const target = resolveInWorkspace(root, requireString(args, 'path'))
    const shown = relativeToWorkspace(root, target)
    const after = preview.diff!.after

    await writeFile(target, after, 'utf8')

    return { content: `Изменено: ${shown}`, diff: preview.diff }
  },
}

async function* walk(dir: string, root: string): AsyncGenerator<string> {
  const entries = await readdir(dir, { withFileTypes: true }).catch(() => [])

  for (const entry of entries) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) {
      if (IGNORED_DIRS.has(entry.name) || entry.name.startsWith('.')) continue
      yield* walk(full, root)
    } else if (entry.isFile()) {
      yield full
    }
  }
}

/** Переводит glob-шаблон в регулярное выражение. Поддержаны `*`, `**` и `?`. */
function globToRegExp(pattern: string): RegExp {
  const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&')
  const expanded = escaped
    .replace(/\*\*\//g, ' SLASHSTAR ')
    .replace(/\*\*/g, ' DOUBLESTAR ')
    .replace(/\*/g, '[^/]*')
    .replace(/\?/g, '[^/]')
    .replace(/ SLASHSTAR /g, '(?:.*/)?')
    .replace(/ DOUBLESTAR /g, '.*')

  return new RegExp(`^${expanded}$`)
}

export const globTool: ToolDefinition = {
  name: 'glob',
  description:
    'Найти файлы по шаблону имени, например "**/*.ts" или "src/**/test_*.py". Возвращает список путей.',
  parameters: {
    type: 'object',
    properties: {
      pattern: { type: 'string', description: 'Glob-шаблон относительно корня рабочей папки' },
    },
    required: ['pattern'],
  },
  mutating: false,
  needsWorkspace: true,
  async execute(args, context) {
    const root = requireWorkspace(context)
    const pattern = requireString(args, 'pattern')
    const matcher = globToRegExp(pattern)

    const matches: string[] = []
    for await (const file of walk(root, root)) {
      if (context.signal.aborted) break
      const rel = relative(root, file)
      if (matcher.test(rel)) {
        matches.push(rel)
        if (matches.length >= MAX_GLOB_RESULTS) break
      }
    }

    if (matches.length === 0) return { content: `Ничего не найдено по шаблону ${pattern}` }

    const footer = matches.length >= MAX_GLOB_RESULTS ? `\n… показаны первые ${MAX_GLOB_RESULTS}` : ''
    return { content: `${matches.length} совпадений:\n${matches.join('\n')}${footer}` }
  },
}

export const grepTool: ToolDefinition = {
  name: 'grep',
  description:
    'Найти текст или регулярное выражение в файлах рабочей папки. Возвращает совпадения с номерами строк.',
  parameters: {
    type: 'object',
    properties: {
      pattern: { type: 'string', description: 'Регулярное выражение для поиска' },
      path: { type: 'string', description: 'Ограничить поиск этой поддиректорией' },
      glob: { type: 'string', description: 'Ограничить поиск файлами по шаблону, например "*.ts"' },
    },
    required: ['pattern'],
  },
  mutating: false,
  needsWorkspace: true,
  async execute(args, context) {
    const root = requireWorkspace(context)
    const pattern = requireString(args, 'pattern')
    const searchRoot = resolveInWorkspace(root, optionalString(args, 'path') ?? '.')
    const globPattern = optionalString(args, 'glob')
    const fileMatcher = globPattern ? globToRegExp(globPattern) : null

    let regex: RegExp
    try {
      regex = new RegExp(pattern, 'i')
    } catch {
      throw new ToolError(`Некорректное регулярное выражение: ${pattern}`)
    }

    const results: string[] = []
    let scanned = 0

    for await (const file of walk(searchRoot, root)) {
      if (context.signal.aborted || results.length >= MAX_GREP_MATCHES) break

      const rel = relative(root, file)
      if (fileMatcher && !fileMatcher.test(rel.split('/').pop() ?? rel) && !fileMatcher.test(rel)) {
        continue
      }

      const info = await stat(file).catch(() => null)
      if (!info || info.size > MAX_READ_BYTES) continue

      const content = await readFile(file, 'utf8').catch(() => null)
      if (content === null || content.includes('\0')) continue

      scanned++
      const lines = content.split('\n')
      for (let i = 0; i < lines.length; i++) {
        if (results.length >= MAX_GREP_MATCHES) break
        const line = lines[i]!
        if (regex.test(line)) {
          results.push(`${rel}:${i + 1}: ${line.trim().slice(0, 200)}`)
        }
      }
    }

    if (results.length === 0) {
      return { content: `Совпадений не найдено (просмотрено файлов: ${scanned})` }
    }

    const footer =
      results.length >= MAX_GREP_MATCHES ? `\n… показаны первые ${MAX_GREP_MATCHES} совпадений` : ''
    return { content: `${results.length} совпадений:\n${results.join('\n')}${footer}` }
  },
}

export const FS_TOOLS: readonly ToolDefinition[] = [
  listDirTool,
  readFileTool,
  writeFileTool,
  editFileTool,
  globTool,
  grepTool,
]
