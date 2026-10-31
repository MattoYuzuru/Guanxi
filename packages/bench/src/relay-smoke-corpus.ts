// B3-b: the smoke-cohort task corpus. Metadata only: ids, titles, dependencies, acceptance argv and the
// identity (git blob ids) of the protected acceptance tests of the private `ledger-lite` fixture repository.
// Nothing from its SPEC.md is copied here. Pure: no IO, no clock.
import { createHash } from 'node:crypto'
import { relayPlanSchema } from '@guanxi/contract'
import type { z } from 'zod'

export type SmokePlan = z.infer<typeof relayPlanSchema>

/** The fixture repository base commit (Guanxi-Test-Repo, `ledger-lite`). */
export const SMOKE_BASE_COMMIT = '51c44bfd10f4f756d0efbab050555dec9a9e8fea'
export const SMOKE_GOAL = 'Implement the ledger-lite items of this plan exactly as SPEC.md specifies. Never edit anything under test/.'

interface FixtureItem { title: string; module: string; test: string; blob: string; dependsOn: readonly string[] }
/** Section titles are the headings of SPEC.md; `blob` is the git blob id of the protected test file at the base commit. */
export const LEDGER_LITE: Readonly<Record<string, FixtureItem>> = Object.freeze({
  I01: { title: 'Parse and format money', module: 'src/01-money.mjs', test: 'test/01-money.test.mjs', blob: '7587aec099679e7d54e17184ff7ca44a8ba0ea26', dependsOn: [] },
  I02: { title: 'Currency-safe arithmetic and allocation', module: 'src/02-money-ops.mjs', test: 'test/02-money-ops.test.mjs', blob: '74abc99750dedc060a12076d4c6aad205810a371', dependsOn: ['I01'] },
  I03: { title: 'Calendar dates', module: 'src/03-dates.mjs', test: 'test/03-dates.test.mjs', blob: '38ea052214055605e343a217e0fe2a7441a79599', dependsOn: [] },
  I04: { title: 'Payee cleanup and normalization', module: 'src/04-payees.mjs', test: 'test/04-payees.test.mjs', blob: '3ddecdf0d79a6e55a41099d78d9be242b8d5ce16', dependsOn: [] },
  I05: { title: 'CSV record parsing', module: 'src/05-csv.mjs', test: 'test/05-csv.test.mjs', blob: '68f46a1dc509b70b312bf1c3d1c3870255dd9076', dependsOn: [] },
  I06: { title: 'CSV transaction import', module: 'src/06-csv-import.mjs', test: 'test/06-csv-import.test.mjs', blob: 'b91fc5ddc5f4327ba483366c897890e585120f4e', dependsOn: ['I01', 'I03', 'I04', 'I05'] },
  I07: { title: 'Category rules engine', module: 'src/07-rules.mjs', test: 'test/07-rules.test.mjs', blob: 'f359b0eaf4325f4fc3f915b5ffd0cef4f161cb24', dependsOn: ['I04'] },
  I08: { title: 'Deterministic transaction sorting', module: 'src/08-sorting.mjs', test: 'test/08-sorting.test.mjs', blob: '7a2353801008929e49b92cfa5fcf4294ec9a1188', dependsOn: ['I03', 'I04'] },
  I09: { title: 'Monthly category summaries', module: 'src/09-summary.mjs', test: 'test/09-summary.test.mjs', blob: 'bc7022ee9da6335d0e0bb1b7c4d4cb3919bb6002', dependsOn: ['I03'] },
  I10: { title: 'Running balance', module: 'src/10-balance.mjs', test: 'test/10-balance.test.mjs', blob: '87820a2695f6bc7c8550535d18143c5d2b9a33b8', dependsOn: ['I08'] },
  I11: { title: 'Budget versus actual', module: 'src/11-budget.mjs', test: 'test/11-budget.test.mjs', blob: 'edbb03cd4275dc6aef3ba25ad6378cf23a60fb52', dependsOn: ['I03', 'I09'] },
  I12: { title: 'Recurring transaction expansion', module: 'src/12-recurring.mjs', test: 'test/12-recurring.test.mjs', blob: '22062b4c0bbe6a80d5e242a76b0f535827b9049b', dependsOn: ['I03'] },
  I13: { title: 'Duplicate detection', module: 'src/13-duplicates.mjs', test: 'test/13-duplicates.test.mjs', blob: 'aa75905742dd0c90c40cf8063998e7e3ad743408', dependsOn: ['I03', 'I04'] },
  I14: { title: 'Multi-currency conversion', module: 'src/14-fx.mjs', test: 'test/14-fx.test.mjs', blob: '5e976bfc16c9476713ba0e440ea381a76982f59e', dependsOn: ['I01', 'I02'] },
  I15: { title: 'Reconciliation', module: 'src/15-reconcile.mjs', test: 'test/15-reconcile.test.mjs', blob: '6c079ef9401318232e7b93126a440ccd14b3fd59', dependsOn: ['I03', 'I04'] },
  I16: { title: 'Query DSL', module: 'src/16-query.mjs', test: 'test/16-query.test.mjs', blob: 'f94824994884e38ddc482fa5490e2df2bf16f179', dependsOn: ['I01', 'I03'] },
  I17: { title: 'JSON archive with versioning', module: 'src/17-archive.mjs', test: 'test/17-archive.test.mjs', blob: 'bc008b8ed21b085cee5a0fe53d98d95f53076e09', dependsOn: ['I03'] },
  I18: { title: 'Undo/redo edit log', module: 'src/18-undo.mjs', test: 'test/18-undo.test.mjs', blob: '0e5b7c74fb88743e902d4c1278c76f718745aa33', dependsOn: ['I03'] },
  I19: { title: 'Ledger report formatter', module: 'src/19-report.mjs', test: 'test/19-report.test.mjs', blob: 'bff47935f1f0a495b861c4fb5a78e1fd13b9f127', dependsOn: ['I01', 'I08', 'I10'] },
  I20: { title: 'CSV transaction export', module: 'src/20-csv-export.mjs', test: 'test/20-csv-export.test.mjs', blob: 'b661bdc330fc3364432bc7ee84f594bc9ed10150', dependsOn: ['I01', 'I05', 'I06'] },
})

export interface SmokeTask { id: string; items: readonly string[] }
/** Five tasks of five items each; every dependency of an item is inside its task. */
export const SMOKE_TASKS: readonly SmokeTask[] = Object.freeze([
  { id: 'll-money-text', items: ['I01', 'I02', 'I03', 'I04', 'I05'] },
  { id: 'll-order-balance', items: ['I03', 'I04', 'I08', 'I09', 'I10'] },
  { id: 'll-budget-dups', items: ['I03', 'I04', 'I09', 'I11', 'I13'] },
  { id: 'll-rules-fx', items: ['I01', 'I02', 'I04', 'I07', 'I14'] },
  { id: 'll-query-log', items: ['I01', 'I03', 'I16', 'I17', 'I18'] },
])

const digest = (tuple: unknown) => createHash('sha256').update(JSON.stringify(tuple)).digest('hex')
const taskOf = (id: string): SmokeTask => {
  const task = SMOKE_TASKS.find(t => t.id === id)
  if (!task) throw new Error('smoke_task_unknown')
  return task
}

/** The relay plan the public start accepts for one task. Revision is the task id; the base is the pinned commit. */
export function smokePlan(taskId: string): SmokePlan {
  const task = taskOf(taskId)
  return relayPlanSchema.parse({
    revision: task.id, base: SMOKE_BASE_COMMIT, goal: SMOKE_GOAL, protectedPaths: ['test'],
    items: task.items.map(id => {
      const item = LEDGER_LITE[id]!
      return { id, title: `Implement SPEC.md section "${id} — ${item.title}"`, dependsOn: [...item.dependsOn],
        acceptance: ['node', '--test', item.test], protectedPaths: ['test'] }
    }),
  })
}

const selected = (taskIds: readonly string[]) => [...taskIds].sort().map(taskOf)
/** Fixed-field digests over the selected tasks (unordered sets sorted). */
export function smokeDigests(taskIds: readonly string[]): { taskManifestSha256: string; acceptanceSha256: string; verifierSetSha256: string } {
  const tasks = selected(taskIds)
  const used = [...new Set(tasks.flatMap(t => t.items))].sort()
  return {
    taskManifestSha256: digest(['guanxi.b3.smoke.tasks/v1', SMOKE_BASE_COMMIT, SMOKE_GOAL,
      tasks.map(t => [t.id, t.items.map(i => [i, LEDGER_LITE[i]!.title, [...LEDGER_LITE[i]!.dependsOn].sort()])])]),
    acceptanceSha256: digest(['guanxi.b3.smoke.acceptance/v1',
      tasks.map(t => [t.id, t.items.map(i => [i, ['node', '--test', LEDGER_LITE[i]!.test]])])]),
    verifierSetSha256: digest(['guanxi.b3.smoke.verifiers/v1', SMOKE_BASE_COMMIT, used.map(i => [LEDGER_LITE[i]!.test, LEDGER_LITE[i]!.blob])]),
  }
}

/** Test files (path, git blob id) a preflight must find in the fixture checkout at the base commit. */
export function smokeVerifierBlobs(taskIds: readonly string[]): ReadonlyArray<{ path: string; blob: string }> {
  const used = [...new Set(selected(taskIds).flatMap(t => t.items))].sort()
  return used.map(i => ({ path: LEDGER_LITE[i]!.test, blob: LEDGER_LITE[i]!.blob }))
}
export const SMOKE_TASK_IDS: readonly string[] = SMOKE_TASKS.map(t => t.id)
