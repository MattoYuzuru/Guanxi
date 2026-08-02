/**
 * Состояние Ollama: установлена ли, запущена ли, и что сказать пользователю, если нет.
 *
 * «Установлена» и «запущена» — разные вещи, и путать их нельзя: бинарь может лежать
 * на диске, но сервис не поднят. Интерфейсу нужны обе подсказки по отдельности.
 */
import { execFile } from 'node:child_process'
import os from 'node:os'
import { promisify } from 'node:util'
import type { OllamaStatus } from '@alamo/contract'
import { OllamaProtocolError, type OllamaClient } from './client.ts'

const execFileAsync = promisify(execFile)

async function binaryOnPath(): Promise<boolean> {
  const command = os.platform() === 'win32' ? 'where' : 'which'
  try {
    await execFileAsync(command, ['ollama'], { timeout: 2_000 })
    return true
  } catch {
    return false
  }
}

function installHint(): { command: string; docsUrl: string } {
  switch (os.platform()) {
    case 'darwin':
      return { command: 'brew install ollama', docsUrl: 'https://docs.ollama.com/macos' }
    case 'linux':
      return {
        command: 'curl -fsSL https://ollama.com/install.sh | sh',
        docsUrl: 'https://docs.ollama.com/linux',
      }
    case 'win32':
      return { command: 'winget install Ollama.Ollama', docsUrl: 'https://docs.ollama.com/windows' }
    default:
      return { command: 'ollama', docsUrl: 'https://docs.ollama.com/quickstart' }
  }
}

export interface OllamaStatusOptions {
  binaryInstalled?: () => Promise<boolean>
  now?: () => Date
}

export async function getOllamaStatus(
  client: OllamaClient,
  options: OllamaStatusOptions = {},
): Promise<OllamaStatus> {
  const observedAt = (options.now ?? (() => new Date()))().toISOString()
  let version: string | null = null
  let incompatible = false
  try {
    version = await client.version()
  } catch (error) {
    incompatible = error instanceof OllamaProtocolError
    version = null
  }

  // Отвечает по HTTP — значит и установлена, и запущена, проверять бинарь незачем.
  if (version !== null) {
    return {
      installed: true,
      installSource: 'runtime_response',
      running: true,
      state: 'reachable',
      source: 'ollama_api_version',
      observedAt,
      version,
      host: client.host,
      installHint: null,
    }
  }

  const installed = await (options.binaryInstalled ?? binaryOnPath)()
  return {
    installed,
    installSource: 'local_binary_path',
    running: false,
    state: incompatible ? 'incompatible' : 'unavailable',
    source: 'ollama_api_version',
    observedAt,
    version: null,
    host: client.host,
    installHint: installed ? { command: 'ollama serve', docsUrl: 'https://docs.ollama.com/cli' } : installHint(),
  }
}
