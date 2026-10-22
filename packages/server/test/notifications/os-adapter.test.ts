import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  createDefaultCommandRunner,
  createOsNotifier,
  OS_NOTIFY_TIMEOUT_MS,
  type CommandRunner,
  type OsNotifier,
  type OsNotifierOptions,
} from '../../src/notifications/os-adapter.ts'

const APP_NAME = 'Guanxi'
const TAG = 'quota:five_hour'
const INJECTION = '" & do shell script "rm -rf ~" & "'

// Fixed independently of the implementation so a changed script is a test failure.
const MACOS_SCRIPT = [
  'on run argv',
  'display notification (item 1 of argv) with title (item 2 of argv)',
  'end run',
]
const MACOS_SCRIPT_ARGS = MACOS_SCRIPT.flatMap(line => ['-e', line])

interface Call {
  file: string
  args: string[]
  opts: { timeoutMs: number }
}

interface RunnerResult {
  code: number | null
  signal: string | null
}

function recordingRunner(result: RunnerResult = { code: 0, signal: null }): {
  runner: CommandRunner
  calls: Call[]
} {
  const calls: Call[] = []
  return {
    calls,
    runner: {
      async run(file, args, opts) {
        calls.push({ file, args: [...args], opts: { ...opts } })
        return result
      },
    },
  }
}

function expectNotifier(value: OsNotifier | { unavailable: string }): OsNotifier {
  if ('unavailable' in value) assert.fail(`expected an OS notifier, got ${value.unavailable}`)
  return value
}

function linuxNotifier(
  result?: RunnerResult,
  resolveBinary: (name: string) => string | null = () => '/usr/bin/notify-send',
): { notifier: OsNotifier; calls: Call[] } {
  const { runner, calls } = recordingRunner(result)
  const notifier = expectNotifier(createOsNotifier({
    platform: 'linux',
    runner,
    appName: APP_NAME,
    resolveBinary,
  }))
  return { notifier, calls }
}

test('macOS uses a constant AppleScript and passes the payload after --', async () => {
  const { runner, calls } = recordingRunner()
  const notifier = expectNotifier(createOsNotifier({
    platform: 'darwin',
    runner,
    appName: APP_NAME,
    resolveBinary: () => {
      throw new Error('macOS must not resolve notify-send')
    },
  }))

  assert.deepEqual(
    await notifier.notify({ title: 'Quota 10% left', tag: TAG }),
    { delivered: true, code: 'delivered' },
  )

  assert.equal(calls.length, 1)
  const call = calls[0]!
  assert.equal(call.file, '/usr/bin/osascript')
  assert.deepEqual(call.args, [...MACOS_SCRIPT_ARGS, '--', 'Quota 10% left', APP_NAME])
  assert.deepEqual(call.opts, { timeoutMs: 5_000 })
  assert.equal(call.args.includes(TAG), false, 'the tag is for callers, not the notifier')

  const scriptLines = call.args
    .slice(0, MACOS_SCRIPT_ARGS.length)
    .filter((_value, index) => index % 2 === 1)
  assert.deepEqual(scriptLines, MACOS_SCRIPT)
})

test('macOS keeps an AppleScript-injection title out of every -e script line', async () => {
  const { runner, calls } = recordingRunner()
  const notifier = expectNotifier(createOsNotifier({
    platform: 'darwin',
    runner,
    appName: APP_NAME,
    resolveBinary: () => null,
  }))

  assert.deepEqual(
    await notifier.notify({ title: INJECTION, tag: 'quota' }),
    { delivered: true, code: 'delivered' },
  )

  const args = calls[0]!.args
  const separator = args.indexOf('--')
  assert.equal(separator, MACOS_SCRIPT_ARGS.length)
  assert.deepEqual(args.slice(0, separator), MACOS_SCRIPT_ARGS)
  assert.deepEqual(args.slice(separator + 1), [INJECTION, APP_NAME])
  assert.equal(args.filter(value => value === INJECTION).length, 1)
  assert.equal(
    args.slice(0, separator).some(value => value.includes('rm -rf')),
    false,
    'payload text must never appear inside the AppleScript arguments',
  )
  assert.deepEqual(
    args.slice(0, separator).filter((_value, index) => index % 2 === 1),
    MACOS_SCRIPT,
  )
})

test('Linux passes the exact notify-send argv with no body and no tag', async () => {
  const resolveCalls: string[] = []
  const { runner, calls } = recordingRunner()
  const notifier = expectNotifier(createOsNotifier({
    platform: 'linux',
    runner,
    appName: APP_NAME,
    resolveBinary(name) {
      resolveCalls.push(name)
      return '/usr/bin/notify-send'
    },
  }))

  assert.deepEqual(
    await notifier.notify({ title: 'Quota 10% left', tag: TAG }),
    { delivered: true, code: 'delivered' },
  )

  assert.deepEqual(resolveCalls, ['notify-send'])
  assert.equal(calls.length, 1)
  assert.equal(calls[0]!.file, '/usr/bin/notify-send')
  assert.deepEqual(calls[0]!.args, ['--app-name', APP_NAME, '--', 'Quota 10% left'])
  assert.equal(calls[0]!.args.includes(TAG), false)
  assert.deepEqual(calls[0]!.opts, { timeoutMs: 5_000 })
})

test('Linux refuses a missing, empty or relative notify-send without running anything', () => {
  const cases: Array<[string | null, string]> = [
    [null, 'notify_send_missing'],
    ['', 'notify_send_missing'],
    ['bin/notify-send', 'notify_send_path_invalid'],
    ['notify-send', 'notify_send_path_invalid'],
    ['/usr/bin/notify-send\u0000', 'notify_send_path_invalid'],
  ]

  for (const [binary, code] of cases) {
    const { runner, calls } = recordingRunner()
    const value = createOsNotifier({
      platform: 'linux',
      runner,
      appName: APP_NAME,
      resolveBinary: () => binary,
    })
    assert.deepEqual(value, { unavailable: code }, `binary ${JSON.stringify(binary)}`)
    assert.equal(calls.length, 0)
  }
})

test('an invalid app name is unavailable before any resolution or run', () => {
  for (const appName of ['', '   ', 'Guanxi\n', 'a'.repeat(121)]) {
    const { runner, calls } = recordingRunner()
    const value = createOsNotifier({
      platform: 'linux',
      runner,
      appName,
      resolveBinary: () => {
        throw new Error('an invalid app name must not resolve a binary')
      },
    })
    assert.deepEqual(value, { unavailable: 'app_name_invalid' }, JSON.stringify(appName))
    assert.equal(calls.length, 0)
  }
})

test('Windows and unknown platforms are unavailable before any resolution or run', () => {
  for (const platform of ['win32', 'freebsd'] as NodeJS.Platform[]) {
    const { runner, calls } = recordingRunner()
    const value = createOsNotifier({
      platform,
      runner,
      appName: APP_NAME,
      resolveBinary: () => {
        throw new Error('unsupported platforms must not resolve a binary')
      },
    })
    assert.deepEqual(value, { unavailable: 'platform_unsupported' })
    assert.equal(calls.length, 0)
  }
})

test('payload validation refuses extra keys, long titles and control characters', async () => {
  const { notifier, calls } = linuxNotifier()
  const secret = 'sk-live-SECRET-looking-value-42'
  const hiddenSecret = { title: 'Quota 10% left', tag: 'quota' }
  Object.defineProperty(hiddenSecret, 'body', { value: secret, enumerable: false })

  const invalid: unknown[] = [
    { title: 'Quota 10% left', tag: 'quota:five_hour', body: secret },
    hiddenSecret,
    { title: 'a'.repeat(121), tag: 'quota' },
    { title: 'Quota\n10% left', tag: 'quota' },
    { title: 'Quota\u000010% left', tag: 'quota' },
    { title: 'Quota\u007f10% left', tag: 'quota' },
    { title: 'Quota 10% left', tag: 'quota\nfive_hour' },
    { title: 'Quota 10% left', tag: 't'.repeat(121) },
    { title: '', tag: 'quota' },
    { title: '   ', tag: 'quota' },
    { title: 42, tag: 'quota' },
    { title: 'Quota 10% left', tag: 42 },
    { title: 'Quota 10% left' },
    null,
    ['Quota 10% left', 'quota'],
  ]

  for (const payload of invalid) {
    assert.deepEqual(
      await notifier.notify(payload as { title: string; tag: string }),
      { delivered: false, code: 'payload_invalid' },
    )
  }

  assert.equal(calls.length, 0, 'invalid payloads must never reach the runner')
  assert.equal(JSON.stringify(calls).includes(secret), false)
})

test('titles are trimmed and 120 characters after trimming is accepted', async () => {
  const { notifier, calls } = linuxNotifier()
  const title = 'x'.repeat(120)

  assert.deepEqual(
    await notifier.notify({ title: `  ${title}  `, tag: TAG }),
    { delivered: true, code: 'delivered' },
  )
  assert.deepEqual(calls[0]!.args, ['--app-name', APP_NAME, '--', title])
})

test('runner non-zero exits, signals and timeouts map to os_notify_failed', async () => {
  const failures: RunnerResult[] = [
    { code: 1, signal: null },
    { code: null, signal: 'SIGTERM' },
    { code: null, signal: null },
  ]

  for (const result of failures) {
    const { notifier, calls } = linuxNotifier(result)
    assert.deepEqual(
      await notifier.notify({ title: 'Quota 10% left', tag: TAG }),
      { delivered: false, code: 'os_notify_failed' },
    )
    assert.deepEqual(calls[0]!.opts, { timeoutMs: 5_000 })
  }
})

test('a throwing runner maps to os_notify_failed without leaking its message', async () => {
  const runner: CommandRunner = {
    async run() {
      throw new Error('spawn failed for sk-live-SECRET-looking-value-42')
    },
  }
  const notifier = expectNotifier(createOsNotifier({
    platform: 'linux',
    runner,
    appName: APP_NAME,
    resolveBinary: () => '/usr/bin/notify-send',
  }))

  const result = await notifier.notify({ title: 'Quota 10% left', tag: TAG })
  assert.deepEqual(result, { delivered: false, code: 'os_notify_failed' })
  assert.equal(JSON.stringify(result).includes('SECRET'), false)
})

test('darwin smoke: the default runner executes an absolute binary via execFile', async t => {
  if (process.platform !== 'darwin') {
    t.skip('darwin-only smoke; no real notifier is spawned elsewhere')
    return
  }

  const runner = createDefaultCommandRunner()
  const result = await runner.run(
    '/usr/bin/true',
    ['--', 'not shown'],
    { timeoutMs: OS_NOTIFY_TIMEOUT_MS },
  )
  assert.deepEqual(result, { code: 0, signal: null })
})
