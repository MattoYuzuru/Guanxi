/**
 * Выполнение команд оболочки в рабочей директории.
 *
 * Самый опасный инструмент набора: изоляция по путям на него не распространяется —
 * команда может обратиться куда угодно. Поэтому он выключен по умолчанию,
 * всегда требует подтверждения человеком и запрещён в удалённом режиме.
 */
import { spawn } from 'node:child_process'
import { ToolError, requireString, requireWorkspace, type ToolDefinition } from './types.ts'

const DEFAULT_TIMEOUT_MS = 120_000
const MAX_OUTPUT_BYTES = 64 * 1024

export const bashTool: ToolDefinition = {
  name: 'bash',
  description:
    'Выполнить команду оболочки в рабочей директории. Использовать только когда задачу нельзя решить файловыми инструментами.',
  parameters: {
    type: 'object',
    properties: {
      command: { type: 'string', description: 'Команда для выполнения' },
      timeout_ms: { type: 'number', description: 'Таймаут в миллисекундах, по умолчанию 120000' },
    },
    required: ['command'],
  },
  mutating: true,
  needsWorkspace: true,
  async execute(args, context) {
    if (!context.enableBash) {
      throw new ToolError('Выполнение команд отключено в настройках')
    }

    const cwd = requireWorkspace(context)
    const command = requireString(args, 'command')
    const timeoutMs = Number(args['timeout_ms']) || DEFAULT_TIMEOUT_MS

    return await new Promise((resolve, reject) => {
      const child = spawn(command, {
        cwd,
        shell: true,
        // Отключаем интерактивные пейджеры: агент не сможет ответить на их запрос.
        env: { ...process.env, PAGER: 'cat', GIT_PAGER: 'cat', TERM: 'dumb' },
      })

      let stdout = ''
      let stderr = ''
      let truncated = false
      let settled = false

      const append = (target: 'out' | 'err', chunk: string) => {
        const current = target === 'out' ? stdout : stderr
        if (current.length >= MAX_OUTPUT_BYTES) {
          truncated = true
          return
        }
        const room = MAX_OUTPUT_BYTES - current.length
        const piece = chunk.length > room ? chunk.slice(0, room) : chunk
        if (piece.length < chunk.length) truncated = true
        if (target === 'out') stdout += piece
        else stderr += piece
      }

      const timer = setTimeout(() => {
        child.kill('SIGKILL')
        finish(null, `Команда прервана по таймауту ${timeoutMs} мс`)
      }, timeoutMs)

      const onAbort = () => {
        child.kill('SIGKILL')
        finish(null, 'Команда прервана пользователем')
      }
      context.signal.addEventListener('abort', onAbort, { once: true })

      const finish = (code: number | null, note?: string) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        context.signal.removeEventListener('abort', onAbort)

        const parts: string[] = []
        if (note) parts.push(note)
        parts.push(`Код возврата: ${code ?? 'нет'}`)
        if (stdout.trim()) parts.push(`stdout:\n${stdout.trimEnd()}`)
        if (stderr.trim()) parts.push(`stderr:\n${stderr.trimEnd()}`)
        if (truncated) parts.push(`… вывод обрезан до ${MAX_OUTPUT_BYTES} Б`)
        if (!stdout.trim() && !stderr.trim() && !note) parts.push('(пустой вывод)')

        resolve({ content: parts.join('\n\n') })
      }

      child.stdout.setEncoding('utf8')
      child.stderr.setEncoding('utf8')
      child.stdout.on('data', (chunk: string) => append('out', chunk))
      child.stderr.on('data', (chunk: string) => append('err', chunk))

      child.on('error', (error) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        context.signal.removeEventListener('abort', onAbort)
        reject(new ToolError(`Не удалось запустить команду: ${error.message}`))
      })

      child.on('close', (code) => finish(code))
    })
  },
}
