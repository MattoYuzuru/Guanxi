import { spawn, execFile, type ChildProcess } from 'node:child_process'
import { createHash } from 'node:crypto'
import { accessSync, constants, lstatSync, mkdirSync, readFileSync, realpathSync, statSync, unlinkSync } from 'node:fs'
import type { Readable, Writable } from 'node:stream'
import { isAbsolute, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { PrivateChannelHost } from './private-channel.ts'
import { servePrivateTrialStreams, type PrivateStreamPolicy, type PrivateStreamReason } from './private-stream.ts'
import type { PublicAssistantMessage } from './public-projection.ts'
import { nonceHash, trialBindingTag, type TrialBinding } from './trial-binding.ts'

const supervisorPath = fileURLToPath(new URL('./private-supervisor.mjs', import.meta.url))
const launcherPath = fileURLToPath(new URL('./private-client-launcher.mjs', import.meta.url))

export interface PrivateProcessPolicy {
  clientScript: string
  cwd: string
  env: Readonly<Record<string, string>>
  recordDirectory: string
  startupTimeoutMs: number
  shutdownGraceMs: number
  killGraceMs: number
  maximumControlBytes: number
  maximumRecordBytes: number
  channel: PrivateStreamPolicy
}

export type PrivateTrialReason = PrivateStreamReason | 'binding_invalid'
  | 'binding_attempt_mismatch' | 'process_policy_invalid' | 'child_start_failed'
  | 'child_exit_failed' | 'retention_fenced' | 'retention_not_ready'
  | 'retention_idempotency_conflict' | 'retention_too_large'
  | 'retention_unsupported_content' | 'retention_id_invalid' | 'retention_failed'
  | 'retention_unconfirmed' | 'cleanup_unconfirmed' | 'binding_busy'

export interface PrivateTrialResult {
  reason: PrivateTrialReason
  responsesDelivered: number
  childExitCode: number | null
  retentionConfirmed: boolean
  cleanupConfirmed: boolean
}

export interface PrivateTrialHost extends PrivateChannelHost {
  retainAndProject(requestId: string, result: Parameters<PrivateChannelHost['retain']>[1]): Promise<PublicAssistantMessage>
}

export interface PrivateTrialOptions {
  binding: TrialBinding
  host: PrivateTrialHost
  policy: PrivateProcessPolicy
  signal?: AbortSignal
}

export class PrivateProcessError extends Error {
  readonly code: PrivateTrialReason
  constructor(code: PrivateTrialReason) { super(code); this.name = 'PrivateProcessError'; this.code = code }
}

export interface PrivateProcessRecord {
  version: 1
  bindingTag: string
  nonceHash: string
  supervisorPid: number
  pgid: number
  clientPid: number | null
  clientExitCode: number | null
  clientScript: string
  startedAt: number
}

const activeBindings = new Map<string, symbol>()
const recordPattern = /^[a-f0-9]{64}\.json$/

function fail(code: PrivateTrialReason): never { throw new PrivateProcessError(code) }
function positive(value: number): boolean { return Number.isSafeInteger(value) && value > 0 && value <= 0x7fffffff }
function safePath(value: unknown): string {
  if (typeof value !== 'string' || value.length === 0 || value.includes('\0') || value.includes('\n') ||
    value.includes('\r') || /\s/.test(value) || !isAbsolute(value)) fail('process_policy_invalid')
  return value
}
function safeInt(value: unknown): number {
  if (typeof value !== 'number' || !positive(value)) fail('process_policy_invalid')
  return value
}
function validateEnv(env: Readonly<Record<string, string>>): void {
  if (typeof env !== 'object' || env === null || Array.isArray(env)) fail('process_policy_invalid')
  for (const [key, value] of Object.entries(env)) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key) || typeof value !== 'string' || value.includes('\0')) {
      fail('process_policy_invalid')
    }
    if (/^(NODE_OPTIONS|NODE_PATH|LD_PRELOAD|LD_LIBRARY_PATH)$/.test(key) || /^DYLD_/.test(key) ||
      /^GUANXI_/.test(key) || /(?:KEY|TOKEN|SECRET|ACCOUNT|CONNECTION|MODEL|TRIAL|NONCE|PROVIDER)/i.test(key)) {
      fail('process_policy_invalid')
    }
  }
}

function validatedPolicy(policy: PrivateProcessPolicy): PrivateProcessPolicy {
  if (typeof policy !== 'object' || policy === null) fail('process_policy_invalid')
  const channel = policy.channel
  if (typeof channel !== 'object' || channel === null) fail('process_policy_invalid')
  safeInt(policy.startupTimeoutMs); safeInt(policy.shutdownGraceMs); safeInt(policy.killGraceMs)
  safeInt(policy.maximumControlBytes); safeInt(policy.maximumRecordBytes)
  safeInt(channel.maximumPayloadBytes); safeInt(channel.maximumRequests)
  safeInt(channel.requestTimeoutMs); safeInt(channel.maximumInputChunkBytes)
  safeInt(channel.outputTimeoutMs)
  const clientScript = safePath(policy.clientScript)
  const cwd = safePath(policy.cwd)
  const recordDirectory = safePath(policy.recordDirectory)
  validateEnv(policy.env)
  let clientReal = clientScript, cwdReal = cwd, recordReal = recordDirectory
  try {
    accessSync(supervisorPath, constants.R_OK)
    if (!lstatSync(supervisorPath).isFile() || lstatSync(supervisorPath).isSymbolicLink()) fail('process_policy_invalid')
    accessSync(launcherPath, constants.R_OK)
    if (!lstatSync(launcherPath).isFile() || lstatSync(launcherPath).isSymbolicLink()) fail('process_policy_invalid')
    const clientEntry = lstatSync(clientScript)
    if (clientEntry.isSymbolicLink() || !clientEntry.isFile()) fail('process_policy_invalid')
    clientReal = realpathSync(clientScript)
    if (!lstatSync(clientReal).isFile()) fail('process_policy_invalid')
    accessSync(clientReal, constants.R_OK)
    const cwdEntry = lstatSync(cwd)
    if (cwdEntry.isSymbolicLink() || !cwdEntry.isDirectory()) fail('process_policy_invalid')
    cwdReal = realpathSync(cwd)
    if (!statSync(cwdReal).isDirectory()) fail('process_policy_invalid')
    const recordEntry = lstatSync(recordDirectory, { throwIfNoEntry: false })
    if (recordEntry?.isSymbolicLink()) fail('process_policy_invalid')
    if (!recordEntry) mkdirSync(recordDirectory, { recursive: true, mode: 0o700 })
    recordReal = realpathSync(recordDirectory)
    const recordStat = lstatSync(recordReal)
    if (!recordStat.isDirectory() || recordStat.isSymbolicLink() || (recordStat.mode & 0o077) !== 0) {
      fail('process_policy_invalid')
    }
  } catch (error) {
    if (error instanceof PrivateProcessError) throw error
    fail('process_policy_invalid')
  }
  return Object.freeze({
    clientScript: clientReal, cwd: cwdReal, recordDirectory: recordReal,
    env: Object.freeze({ ...policy.env }),
    startupTimeoutMs: policy.startupTimeoutMs, shutdownGraceMs: policy.shutdownGraceMs,
    killGraceMs: policy.killGraceMs, maximumControlBytes: policy.maximumControlBytes,
    maximumRecordBytes: policy.maximumRecordBytes,
    channel: Object.freeze({ ...channel }),
  })
}

function recordPath(binding: TrialBinding, policy: PrivateProcessPolicy): string {
  const name = `${createHash('sha256').update(binding.nonce).digest('hex')}.json`
  if (!recordPattern.test(name)) fail('process_policy_invalid')
  return join(policy.recordDirectory, name)
}

export function privateProcessRecordPath(binding: TrialBinding, policy: PrivateProcessPolicy): string {
  return recordPath(binding, validatedPolicy(policy))
}

type RecordRead = { status: 'absent' } | { status: 'invalid' } | { status: 'ok'; record: PrivateProcessRecord }

function readRecord(path: string, policy: PrivateProcessPolicy): RecordRead {
  let stat
  try { stat = lstatSync(path) } catch (error) {
    const code = typeof error === 'object' && error !== null && 'code' in error ? String(error.code) : ''
    return code === 'ENOENT' ? { status: 'absent' } : { status: 'invalid' }
  }
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > policy.maximumRecordBytes ||
    (stat.mode & 0o077) !== 0) return { status: 'invalid' }
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as Partial<PrivateProcessRecord>
    if (parsed.version !== 1 || typeof parsed.bindingTag !== 'string' || !/^[a-f0-9]{64}$/.test(parsed.bindingTag) ||
      typeof parsed.nonceHash !== 'string' || !/^[a-f0-9]{64}$/.test(parsed.nonceHash) ||
      !Number.isSafeInteger(parsed.supervisorPid) || parsed.supervisorPid! <= 1 ||
      !Number.isSafeInteger(parsed.pgid) || parsed.pgid! <= 1 ||
      (parsed.clientPid !== null && (!Number.isSafeInteger(parsed.clientPid) || parsed.clientPid! <= 1)) ||
      (parsed.clientExitCode !== null && parsed.clientExitCode !== undefined && !Number.isSafeInteger(parsed.clientExitCode)) ||
      typeof parsed.clientScript !== 'string' || parsed.clientScript !== policy.clientScript ||
      !Number.isSafeInteger(parsed.startedAt) || parsed.startedAt! < 0) return { status: 'invalid' }
    return { status: 'ok', record: parsed as PrivateProcessRecord }
  } catch { return { status: 'invalid' } }
}

function unlinkRecord(path: string): boolean {
  try {
    const stat = lstatSync(path)
    if (!stat.isFile() || stat.isSymbolicLink()) return false
    unlinkSync(path)
    return true
  } catch (error) {
    const code = typeof error === 'object' && error !== null && 'code' in error ? String(error.code) : ''
    return code === 'ENOENT'
  }
}

function groupStatus(pgid: number): 'alive' | 'gone' | 'unknown' {
  try { process.kill(-pgid, 0); return 'alive' } catch (error) {
    const code = typeof error === 'object' && error !== null && 'code' in error ? String(error.code) : ''
    return code === 'ESRCH' ? 'gone' : 'unknown'
  }
}
function signalGroup(pgid: number, signal: NodeJS.Signals): void {
  try { process.kill(-pgid, signal) } catch { /* ESRCH or permission; caller verifies */ }
}
function sleep(ms: number): Promise<void> { return new Promise(resolve => setTimeout(resolve, ms)) }
async function groupGone(pgid: number, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (groupStatus(pgid) === 'gone') return true
    await sleep(20)
  }
  return groupStatus(pgid) === 'gone'
}

function ps(args: string[]): Promise<string> {
  return new Promise((resolvePromise, reject) => {
    execFile('/bin/ps', args, { timeout: 1_000, maxBuffer: 64 * 1024, encoding: 'utf8' },
      (error, stdout) => { if (error) reject(error); else resolvePromise(stdout) })
  })
}
export interface ObservedProcess { pid: number; pgid: number; command: string }
export interface PrivateProcessInspection {
  /** Test/deployment seam for the local process-table query; production defaults to /bin/ps. */
  observe?(pid: number): Promise<ObservedProcess | null>
}
interface Observed extends ObservedProcess {}
function parseObserved(output: string): Observed | null {
  const line = output.trim().split('\n')[0]
  if (!line) return null
  const match = /^\s*(\d+)\s+(\d+)\s+(.+)$/.exec(line)
  if (!match) return null
  return { pid: Number(match[1]), pgid: Number(match[2]), command: match[3]! }
}
async function observe(pid: number): Promise<Observed | null> {
  try { return parseObserved(await ps(['-ww', '-p', String(pid), '-o', 'pid=,pgid=,command='])) } catch { return null }
}
type Observer = (pid: number) => Promise<ObservedProcess | null>
function tokens(command: string): string[] { return command.trim().split(/\s+/).filter(Boolean) }
function isSupervisor(observed: Observed, record: PrivateProcessRecord, policy: PrivateProcessPolicy, path: string): boolean {
  if (observed.pid !== record.supervisorPid || observed.pgid !== record.pgid) return false
  const expected = [process.execPath, supervisorPath, policy.clientScript, path,
    String(policy.killGraceMs), record.bindingTag, record.nonceHash]
  return JSON.stringify(tokens(observed.command)) === JSON.stringify(expected)
}
function isClient(observed: Observed, record: PrivateProcessRecord, policy: PrivateProcessPolicy): boolean {
  if (observed.pgid !== record.pgid) return false
  return JSON.stringify(tokens(observed.command)) === JSON.stringify([process.execPath, launcherPath, policy.clientScript])
}
async function findClient(record: PrivateProcessRecord, policy: PrivateProcessPolicy, inspect: Observer): Promise<number | null> {
  if (record.clientPid !== null) {
    const observed = await inspect(record.clientPid)
    return observed && isClient(observed, record, policy) ? observed.pid : null
  }
  try {
    const output = await ps(['-ax', '-o', 'pid=,pgid=,command='])
    for (const line of output.split('\n')) {
      const observed = parseObserved(line)
      if (observed && isClient(observed, record, policy)) return observed.pid
    }
  } catch { /* unknown identity */ }
  return null
}

/** Parent-side verification of an existing record; never signals without exact identity. */
export async function reapPrivateProcessRecord(binding: TrialBinding, policyInput: PrivateProcessPolicy,
  inspection: PrivateProcessInspection = {}): Promise<'absent' | 'removed' | 'cleanup_unconfirmed'> {
  const policy = validatedPolicy(policyInput)
  const inspect: Observer = inspection.observe ?? observe
  const path = recordPath(binding, policy)
  const read = readRecord(path, policy)
  if (read.status === 'absent') return 'absent'
  if (read.status === 'invalid') return 'cleanup_unconfirmed'
  const record = read.record
  if (record.bindingTag !== trialBindingTag(binding) || record.nonceHash !== nonceHash(binding) ||
    record.clientScript !== policy.clientScript) return 'cleanup_unconfirmed'
  const supervisor = await inspect(record.supervisorPid)
  if (supervisor && isSupervisor(supervisor, record, policy, path)) {
    signalGroup(record.pgid, 'SIGTERM')
    await sleep(policy.killGraceMs)
    signalGroup(record.pgid, 'SIGKILL')
    if (!await groupGone(record.pgid, policy.killGraceMs)) return 'cleanup_unconfirmed'
    return unlinkRecord(path) ? 'removed' : 'cleanup_unconfirmed'
  }
  const client = await findClient(record, policy, inspect)
  if (client !== null) {
    signalGroup(record.pgid, 'SIGKILL')
    if (!await groupGone(record.pgid, policy.killGraceMs)) return 'cleanup_unconfirmed'
    return unlinkRecord(path) ? 'removed' : 'cleanup_unconfirmed'
  }
  if (groupStatus(record.pgid) !== 'gone') return 'cleanup_unconfirmed'
  return unlinkRecord(path) ? 'removed' : 'cleanup_unconfirmed'
}

async function readControl(stream: Readable, maximum: number, timeoutMs: number, child: ChildProcess):
Promise<Record<string, unknown>> {
  return new Promise((resolvePromise, reject) => {
    let buffer = Buffer.alloc(0), done = false
    const finish = (error?: Error, value?: Record<string, unknown>) => {
      if (done) return
      done = true; clearTimeout(timer); stream.off('data', onData); stream.off('error', onError); stream.off('close', onClose)
      if (error) reject(error); else resolvePromise(value!)
    }
    const onData = (chunk: Buffer) => {
      buffer = Buffer.concat([buffer, chunk])
      if (buffer.length > maximum) return finish(new PrivateProcessError('child_start_failed'))
      const newline = buffer.indexOf(10)
      if (newline < 0) return
      try {
        const value = JSON.parse(buffer.subarray(0, newline).toString('utf8')) as Record<string, unknown>
        finish(undefined, value)
      } catch { finish(new PrivateProcessError('child_start_failed')) }
    }
    const onError = () => finish(new PrivateProcessError('child_start_failed'))
    const onClose = () => finish(new PrivateProcessError('child_start_failed'))
    const timer = setTimeout(() => {
      try { if (child.pid) signalGroup(child.pid, 'SIGKILL') } catch { /* ignore */ }
      finish(new PrivateProcessError('child_start_failed'))
    }, timeoutMs)
    stream.on('data', onData); stream.on('error', onError); stream.on('close', onClose)
  })
}

function errorCode(error: unknown): PrivateTrialReason {
  if (error instanceof PrivateProcessError) return error.code
  const code = typeof error === 'object' && error !== null && 'code' in error ? String(error.code) : ''
  if (code === 'retention_not_ready') return 'retention_not_ready'
  if (code === 'retention_fenced') return 'retention_fenced'
  if (code === 'retention_idempotency_conflict') return 'retention_idempotency_conflict'
  if (code === 'retention_too_large') return 'retention_too_large'
  if (code === 'retention_unsupported_content') return 'retention_unsupported_content'
  if (code === 'retention_id_invalid') return 'retention_id_invalid'
  if (code === 'retention_failed') return 'retention_failed'
  return 'retention_failed'
}

/**
 * Own one supervised process group and one private capability for a binding.
 * The promise does not resolve while gateway/retention work is pending; no
 * timer, child exit or group signal releases that ownership.
 */
export async function runPrivateTrial(options: PrivateTrialOptions): Promise<PrivateTrialResult> {
  const { binding, host } = options
  const key = binding.nonce
  if (activeBindings.has(key)) {
    return { reason: 'binding_busy', responsesDelivered: 0, childExitCode: null,
      retentionConfirmed: false, cleanupConfirmed: false }
  }
  const token = Symbol(key)
  activeBindings.set(key, token)
  let child: ChildProcess | undefined
  let policy: PrivateProcessPolicy
  try { policy = validatedPolicy(options.policy) } catch (error) {
    activeBindings.delete(key)
    return { reason: errorCode(error), responsesDelivered: 0, childExitCode: null,
      retentionConfirmed: false, cleanupConfirmed: false }
  }
  const path = recordPath(binding, policy)
  let retentionAttempted = false, retentionAcks = 0, retentionFailure: PrivateTrialReason | undefined
  let responsesDelivered = 0, childExitCode: number | null = null
  let closed = false, shutdownStarted = false
  let lifetime: Writable | null | undefined
  let final: PrivateStreamReason | undefined
  const releaseIfSettled = (cleanupConfirmed: boolean) => {
    const retentionConfirmed = retentionAcks > 0 && retentionFailure === undefined
    if (activeBindings.get(key) !== token) return
    if (!cleanupConfirmed) return
    if (retentionAttempted && !retentionConfirmed) return
    activeBindings.delete(key)
  }
  try {
    const prior = await reapPrivateProcessRecord(binding, policy)
    if (prior === 'cleanup_unconfirmed') {
      return { reason: 'cleanup_unconfirmed', responsesDelivered: 0, childExitCode: null,
        retentionConfirmed: false, cleanupConfirmed: false }
    }
    child = spawn(process.execPath, [supervisorPath, policy.clientScript, path, String(policy.killGraceMs),
      trialBindingTag(binding), nonceHash(binding)], {
      detached: true, cwd: policy.cwd, env: { ...policy.env },
      stdio: ['ignore', 'ignore', 'ignore', 'pipe', 'pipe', 'pipe', 'pipe'],
    })
    const current = child as ChildProcess
    current.on('error', () => { closed = true })
    current.on('close', code => { closed = true; childExitCode = code ?? null })
    const stdio = current.stdio as unknown as Array<Readable | Writable | null>
    const control = stdio[6] as Readable | null
    if (!control) fail('child_start_failed')
    const ready = await readControl(control, policy.maximumControlBytes, policy.startupTimeoutMs, current)
    const readyClientPid = ready.clientPid
    if (ready.status !== 'ready' || ready.supervisorPid !== current.pid || ready.pgid !== current.pid ||
      !Number.isSafeInteger(readyClientPid) || (readyClientPid as number) <= 1) fail('child_start_failed')
    control.destroy()
    const stored = readRecord(path, policy)
    if (stored.status !== 'ok' || stored.record.supervisorPid !== current.pid ||
      stored.record.pgid !== current.pid || stored.record.clientPid !== readyClientPid ||
      stored.record.bindingTag !== trialBindingTag(binding) || stored.record.nonceHash !== nonceHash(binding)) {
      fail('cleanup_unconfirmed')
    }
    const input = stdio[4] as Readable | null
    const output = stdio[3] as Writable | null
    lifetime = stdio[5] as Writable | null
    if (!input || !output || !lifetime) fail('child_start_failed')
    lifetime.on('error', () => {})
    const shutdown = () => {
      if (shutdownStarted) return
      shutdownStarted = true
      try { lifetime!.end() } catch { /* supervisor observes EOF */ }
      const timer = setTimeout(() => {
        if (!closed && current.pid) signalGroup(current.pid, 'SIGKILL')
      }, policy.shutdownGraceMs)
      timer.unref()
    }
    const wrappedHost: PrivateTrialHost = {
      model: host.model,
      gateway: host.gateway,
      retain: host.retain,
      retainAndProject: async (requestId, result) => {
        retentionAttempted = true
        try {
          const projection = await host.retainAndProject(requestId, result)
          retentionAcks++
          return projection
        } catch (error) {
          retentionFailure = errorCode(error)
          throw error
        }
      },
    }
    const stream = await servePrivateTrialStreams(input, output, wrappedHost, policy.channel,
      options.signal ?? new AbortController().signal, { onTerminal: shutdown })
    final = stream.reason
    responsesDelivered = stream.responsesDelivered
    shutdown()
    const closeDeadline = policy.shutdownGraceMs + policy.killGraceMs + 1_000
    const deadline = Date.now() + closeDeadline
    while (!closed && Date.now() < deadline) await sleep(20)
    if (!closed && current.pid) {
      signalGroup(current.pid, 'SIGKILL')
      const second = Date.now() + 1_000
      while (!closed && Date.now() < second) await sleep(20)
    }
    const finalRecord = readRecord(path, policy)
    if (finalRecord.status === 'ok' && typeof finalRecord.record.clientExitCode === 'number') {
      childExitCode = finalRecord.record.clientExitCode
    }
    const groupCleared = current.pid ? await groupGone(current.pid, policy.killGraceMs) : false
    const cleanupConfirmed = closed && groupCleared && unlinkRecord(path)
    const retentionConfirmed = retentionAcks > 0 && retentionFailure === undefined
    const reason: PrivateTrialReason = retentionFailure
      ?? (final === 'channel_input_ended' && responsesDelivered === 0 && childExitCode !== null && childExitCode !== 0
        ? 'child_exit_failed' : (final ?? 'child_exit_failed'))
    releaseIfSettled(cleanupConfirmed)
    return { reason, responsesDelivered, childExitCode, retentionConfirmed, cleanupConfirmed }
  } catch (error) {
    if (child?.pid) {
      signalGroup(child.pid, 'SIGKILL')
      const deadline = Date.now() + policy!.killGraceMs + 1_000
      while (!closed && Date.now() < deadline) await sleep(20)
    }
    const cleanupConfirmed = Boolean(child?.pid && closed && await groupGone(child.pid, policy!.killGraceMs) && unlinkRecord(path))
    releaseIfSettled(cleanupConfirmed || !child?.pid)
    return {
      reason: errorCode(error), responsesDelivered, childExitCode,
      retentionConfirmed: retentionAcks > 0 && retentionFailure === undefined,
      cleanupConfirmed,
    }
  }
}
