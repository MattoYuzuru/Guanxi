import { spawn, execFile, type ChildProcess } from 'node:child_process'
import { realpath, mkdir, stat, open, type FileHandle } from 'node:fs/promises'
import { constants } from 'node:fs'
import { dirname, join } from 'node:path'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const quote = (value: string) => JSON.stringify(value)
const packageNames = ['web-tree-sitter', 'ignore', 'tree-sitter-typescript', 'tree-sitter-javascript', 'tree-sitter-python', 'tree-sitter-go', 'tree-sitter-rust', 'tree-sitter-java', 'tree-sitter-c', 'tree-sitter-cpp']
const dependencies = packageNames.map(name => { try { return dirname(require.resolve(`${name}/package.json`)) } catch { return dirname(require.resolve(name)) } })
export const grammarDirectories = Object.fromEntries(packageNames.filter(n => n.startsWith('tree-sitter-')).map(name => [name.slice('tree-sitter-'.length), dirname(require.resolve(`${name}/package.json`))]))
grammarDirectories.tsx = grammarDirectories.typescript!
const gitMetadata = (root: string) => new Promise<string[]>(resolve => execFile('/usr/bin/git', ['--no-optional-locks', '-C', root, 'rev-parse', '--path-format=absolute', '--absolute-git-dir', '--git-common-dir'], {
  env: { PATH: process.env.PATH, HOME: root, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_OPTIONAL_LOCKS: '0' }, timeout: 3000,
}, (error, stdout) => resolve(error ? [] : stdout.trim().split('\n'))))

/** The scanner runs only trusted captured code; this OS boundary also protects
 * against hostile ancestor swaps that pathname checks alone cannot close. */
export async function indexProcess(entry: string, root: string, dataDir: string): Promise<ChildProcess> {
  const databaseDir = join(dataDir, 'knowledge-index')
  await mkdir(databaseDir, { recursive: true, mode: 0o700 })
  const executable = await realpath(process.execPath)
  const cwd = (await stat(root)).isDirectory() ? root : dirname(root)
  const metadata = await gitMetadata(cwd)
  const paths = [...new Set([root, dirname(entry), databaseDir, dirname(executable), ...dependencies, ...metadata])]
  let command: string, args: string[]
  let rootHandle: FileHandle | undefined
  if (process.platform === 'darwin') {
    const system = ['/System', '/usr', '/bin', '/sbin', '/Library/Apple', '/Library/Developer', '/private/etc', '/opt/homebrew/Cellar', '/opt/homebrew/opt']
    const profile = `(version 1)(allow default)(deny network*)(deny file-read*)(deny file-write*)(allow file-read-metadata)(allow file-read* (literal "/"))(allow file-read* ${[...system, ...paths].map(p => `(subpath ${quote(p)})`).join(' ')})(allow file-read* (literal "/dev/null") (literal "/dev/urandom") (literal "/dev/random"))(allow file-write* (subpath ${quote(databaseDir)}) (literal "/dev/null"))`
    command = '/usr/bin/sandbox-exec'; args = ['-p', profile, executable, entry]
  } else if (process.platform === 'linux') {
    rootHandle = await open(root, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
    if (await realpath(`/proc/self/fd/${rootHandle.fd}`) !== root) { await rootHandle.close(); throw new Error('index_root_changed') }
    command = '/usr/bin/bwrap'
    args = ['--die-with-parent', '--unshare-all', '--new-session', '--proc', '/proc', '--dev', '/dev', '--tmpfs', '/tmp']
    for (const path of [...new Set(['/usr', '/bin', '/sbin', '/lib', '/lib64', '/etc', ...paths])].sort((a, b) => a.length - b.length)) {
      try { await realpath(path) } catch { continue }
      args.push('--ro-bind', path === root ? `/proc/${process.pid}/fd/${rootHandle.fd}` : path, path)
    }
    args.push('--bind', databaseDir, databaseDir, '--chdir', cwd, executable, entry)
  } else throw new Error('index_sandbox_unavailable')
  const child = spawn(command, args, { detached: true, cwd,
    env: { PATH: '/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin', HOME: databaseDir, TMPDIR: databaseDir, LANG: 'en_US.UTF-8', OPENSSL_CONF: '/dev/null' },
    stdio: ['ignore', 'ignore', 'ignore', 'ipc'] })
  child.once('close', () => { void rootHandle?.close().catch(() => undefined) })
  return child
}
export async function stopIndexProcess(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return
  const closed = new Promise<void>(resolve => child.once('close', () => resolve()))
  try { process.kill(-child.pid!, 'SIGKILL') } catch { child.kill('SIGKILL') }
  await closed
}
