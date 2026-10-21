import { createHash } from 'node:crypto'
import { taskSchema, type Task } from './protocol.ts'
/** Select metadata only. Real task content stays in the private Harbor registry/cache. */
export function selectCorpus(raw: unknown[], window: { from: string; through: string }, now = new Date()): { tasks: Task[]; sha256: string } {
  const candidates = raw.map(x => taskSchema.parse(x))
  if (!taskSchema.shape.published.safeParse(window.from).success || !taskSchema.shape.published.safeParse(window.through).success || window.from > window.through || window.through > now.toISOString().slice(0, 10)) throw new Error('invalid_fresh_window')
  const age = (Date.parse(window.through) - Date.parse(window.from)) / 86400000
  if (!Number.isFinite(age) || age > 62 || (now.getTime() - Date.parse(window.through)) / 86400000 > 31) throw new Error('fresh_window_too_wide')
  if (new Set(candidates.map(t => t.id)).size !== candidates.length) throw new Error('duplicate_task')
  const sorted = candidates.sort((a, b) => a.id.localeCompare(b.id, 'en'))
  const fresh = sorted.filter(t => t.suite === 'swe-rebench' && t.published >= window.from && t.published <= window.through).slice(0, 50)
  const regression = sorted.filter(t => t.suite === 'verified').slice(0, 30)
  if (fresh.length !== 50 || regression.length !== 30) throw new Error('corpus_requires_50_fresh_30_verified')
  const tasks = [...fresh, ...regression]
  return { tasks, sha256: createHash('sha256').update(JSON.stringify(tasks)).digest('hex') }
}
