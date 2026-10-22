import { execFile } from 'node:child_process'
import { isAbsolute } from 'node:path'

/**
 * Content-free OS notification delivery for ADR-0033 decision 8. The adapter accepts only a
 * short title and an opaque de-duplication tag; the tag is never shown or passed to a
 * notifier. No shell is involved: macOS receives one constant AppleScript and the title as a
 * separate argv element, and Linux passes the title after `--`.
 */

export interface CommandRunner {
  run(
    file: string,
    args: string[],
    opts: { timeoutMs: number },
  ): Promise<{ code: number | null; signal: string | null }>
}

export interface OsNotifier {
  notify(payload: { title: string; tag: string }): Promise<{ delivered: boolean; code: string }>
}

export type UnavailableOsNotifier = { unavailable: string }

export interface OsNotifierOptions {
  platform: NodeJS.Platform
  runner: CommandRunner
  appName: string
  resolveBinary(name: string): string | null
}

export const OS_NOTIFY_TIMEOUT_MS = 5_000
export const MAX_TITLE_LENGTH = 120

/**
 * The AppleScript is constant. `item 1 of argv` is the payload title (the notification
 * message) and `item 2 of argv` is the app name (the notification title); both arrive after
 * `--`, so no payload text is ever parsed as AppleScript.
 */
const MACOS_SCRIPT_LINES = [
  'on run argv',
  'display notification (item 1 of argv) with title (item 2 of argv)',
  'end run',
] as const
const MACOS_SCRIPT_ARGS = MACOS_SCRIPT_LINES.flatMap(line => ['-e', line])
const MACOS_OSASCRIPT = '/usr/bin/osascript'

// C0/C1 controls plus the Unicode line and paragraph separators. The raw value is checked
// before trimming, so a trailing newline is refused rather than silently removed.
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/

function osResult(delivered: boolean, code: string): { delivered: boolean; code: string } {
  return { delivered, code }
}

/**
 * Default runner: `execFile` with no shell, a bounded buffer and the caller's timeout. It
 * never inspects or logs stdout/stderr, which may contain text the caller did not author.
 */
export function createDefaultCommandRunner(): CommandRunner {
  return {
    run(file, args, opts) {
      return new Promise(resolve => {
        execFile(
          file,
          [...args],
          {
            timeout: opts.timeoutMs,
            maxBuffer: 64 * 1024,
            shell: false as const,
            windowsHide: true,
          },
          error => {
            if (error === null) {
              resolve({ code: 0, signal: null })
              return
            }
            const failure = error as Error & {
              code?: string | number | null
              signal?: string | null
            }
            resolve({
              code: typeof failure.code === 'number' ? failure.code : null,
              signal: typeof failure.signal === 'string' ? failure.signal : null,
            })
          },
        )
      })
    },
  }
}

function validatePayload(payload: unknown): string | null {
  if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) return null

  // Only the two own keys are allowed; a secret-bearing extra key is refused before any
  // value is read. Non-enumerable and symbol keys count too.
  const keys = Reflect.ownKeys(payload)
  if (keys.length !== 2 || !keys.includes('title') || !keys.includes('tag')) return null

  const record = payload as Record<string, unknown>
  const rawTitle = record.title
  if (typeof rawTitle !== 'string' || CONTROL_CHARACTERS.test(rawTitle)) return null
  const title = rawTitle.trim()
  if (title.length === 0 || title.length > MAX_TITLE_LENGTH) return null

  // The tag is opaque and never reaches a process, so it has no display-length cap. Its
  // control-character check only keeps a caller's own logs and comparisons predictable.
  const rawTag = record.tag
  if (typeof rawTag !== 'string' || CONTROL_CHARACTERS.test(rawTag)) return null

  return title
}

function normalizeAppName(appName: unknown): string | null {
  if (typeof appName !== 'string' || CONTROL_CHARACTERS.test(appName)) return null
  const trimmed = appName.trim()
  if (trimmed.length === 0 || trimmed.length > MAX_TITLE_LENGTH) return null
  return trimmed
}

/**
 * Build an OS notifier for the current platform, or report why this platform cannot deliver.
 * Invalid app configuration and a bad resolved binary are reported as `unavailable` instead of
 * throwing, so a missing desktop integration never breaks notification ingestion.
 */
export function createOsNotifier(opts: OsNotifierOptions): OsNotifier | UnavailableOsNotifier {
  if (opts.platform !== 'darwin' && opts.platform !== 'linux') {
    return { unavailable: 'platform_unsupported' }
  }

  const appName = normalizeAppName(opts.appName)
  if (appName === null) return { unavailable: 'app_name_invalid' }

  let command: { file: string; args(title: string): string[] }
  if (opts.platform === 'darwin') {
    command = {
      file: MACOS_OSASCRIPT,
      args: title => [...MACOS_SCRIPT_ARGS, '--', title, appName],
    }
  } else {
    const binary = opts.resolveBinary('notify-send')
    if (binary === null || binary.length === 0) return { unavailable: 'notify_send_missing' }
    if (!isAbsolute(binary) || binary.includes('\u0000')) {
      return { unavailable: 'notify_send_path_invalid' }
    }
    command = {
      file: binary,
      args: title => ['--app-name', appName, '--', title],
    }
  }

  return {
    async notify(payload) {
      let title: string | null
      try {
        title = validatePayload(payload)
      } catch {
        title = null
      }
      if (title === null) return osResult(false, 'payload_invalid')

      try {
        const outcome = await opts.runner.run(
          command.file,
          command.args(title),
          { timeoutMs: OS_NOTIFY_TIMEOUT_MS },
        )
        return outcome.code === 0
          ? osResult(true, 'delivered')
          : osResult(false, 'os_notify_failed')
      } catch {
        // The runner's message can contain payload text or host paths; never surface it.
        return osResult(false, 'os_notify_failed')
      }
    },
  }
}
