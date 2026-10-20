/**
 * Child process for K2 crash tests. It appends to a session log and kills
 * itself with SIGKILL at one append point, so the parent can check what a real
 * process death leaves in SQLite.
 *
 * argv: <dbPath> <mode: handle|mirror> <point> <committedBefore>
 */
import { hostname } from 'node:os'
import type { ChatJobInputSnapshot } from '@guanxi/contract'
import { SecretScrubber } from '../../src/egress/scrubber.ts'
import { ChatSessionMirror } from '../../src/session-log/chat-mirror.ts'
import { SessionLog, type SessionAppendPoint } from '../../src/session-log/log.ts'
import { openDb } from '../../src/store/db.ts'
import { JobStore } from '../../src/store/jobs.ts'
import { ThreadStore } from '../../src/store/threads.ts'

const [dbPath, mode, point, committedBeforeText] = process.argv.slice(2) as [
  string,
  'handle' | 'mirror',
  SessionAppendPoint,
  string,
]
const committedBefore = Number(committedBeforeText)
const db = openDb(dbPath)
let armed = false

const log = new SessionLog({
  db,
  scrubber: new SecretScrubber(),
  writer: { id: `crash-worker-${process.pid}`, pid: process.pid, host: hostname() },
  fault(at, detail) {
    if (!armed || at !== point) return
    if (mode === 'handle' && detail.type !== 'prompt') return
    if (mode === 'mirror' && detail.type !== 'job.lifecycle') return
    process.kill(process.pid, 'SIGKILL')
  },
})

if (mode === 'handle') {
  const handle = log.open('crash-session', { kind: 'agent' })
  for (let index = 0; index < committedBefore; index++) {
    handle.append(
      { type: 'prompt', data: { origin: 'typed', messageId: `m-${index}`, text: `committed-${index}`, attachmentCount: 0 } },
      { idempotencyKey: `k-${index}` },
    )
  }
  armed = true
  handle.append(
    { type: 'prompt', data: { origin: 'typed', messageId: 'm-torn', text: 'tornmarker', attachmentCount: 0 } },
    { idempotencyKey: `k-${committedBefore}` },
  )
} else {
  const threads = new ThreadStore(db)
  const thread = threads.create({
    title: 'Crash',
    mode: 'chat',
    model: 'fixture',
    workspaceId: null,
    options: { numCtx: 4_096, temperature: 0, think: 'off' },
  })
  const jobs = new JobStore(db, { sessionMirror: new ChatSessionMirror({ log, db }) })
  const input: ChatJobInputSnapshot = { content: 'crash prompt', attachments: [], autoApprove: null }
  const created = jobs.createChat({
    threadId: thread.id,
    idempotencyScope: `chat:${thread.id}:send:v1`,
    idempotencyKey: crypto.randomUUID(),
    requestFingerprint: 'fixture',
    input,
    derivedTitle: 'Crash',
  })
  process.stdout.write(`${JSON.stringify({ threadId: thread.id, jobId: created.job.id })}\n`)
  armed = true
  jobs.transition({ jobId: created.job.id, expectedStatus: 'queued', status: 'reserving', phase: 'resource_admission' })
}

// Reaching this line means the fault never fired.
process.exit(3)
