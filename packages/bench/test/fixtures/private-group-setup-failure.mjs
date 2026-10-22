import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'
import { groupedHolder } from '../private-process-fixtures.ts'

test('owned fixture setup fails before the caller can enter finally', async t => {
  const root = process.env.BENCH_GROUP_FAILURE_ROOT
  const holder = await groupedHolder(t, root)
  writeFileSync(join(root, 'failure-report.json'), JSON.stringify({
    supervisorPid: holder.supervisor.pid, clientPid: holder.clientPid,
  }))
  throw new Error('intentional owned fixture setup failure')
})
