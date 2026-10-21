import { test } from 'node:test'
import assert from 'node:assert/strict'
import { processJson } from '../src/process.ts'
test('managed process exchanges one JSON record, preserves UTF-8 and strips inherited secret variables', async () => {
  const before = process.env.BENCH_TEST_API_KEY
  process.env.BENCH_TEST_API_KEY = 'fixture-only-sentinel'
  try {
    const result = await processJson(process.execPath, ['-e', `let data='';process.stdin.on('data',c=>data+=c);process.stdin.on('end',()=>{if(process.env.BENCH_TEST_API_KEY)process.exit(5);const b=Buffer.from(JSON.stringify({text:'привет',input:JSON.parse(data)}));process.stdout.write(b.subarray(0,10));setTimeout(()=>process.stdout.write(b.subarray(10)),5)})`], { id: 'fixture' })
    assert.deepEqual(result, { text: 'привет', input: { id: 'fixture' } })
  } finally { if (before === undefined) delete process.env.BENCH_TEST_API_KEY; else process.env.BENCH_TEST_API_KEY = before }
})
test('malformed, oversized, nonzero and canceled processes never return a valid result', async () => {
  await assert.rejects(processJson(process.execPath, ['-e', 'process.stdout.write("not json")'], {}), /malformed_result/)
  await assert.rejects(processJson(process.execPath, ['-e', 'process.exit(9)'], {}), /external_process_failed/)
  await assert.rejects(processJson(process.execPath, ['-e', 'process.stdout.write("x".repeat(5*1024*1024))'], {}), /external_process_failed/)
  await assert.rejects(processJson(process.execPath, ['-e', 'setInterval(()=>{},1000)'], {}, AbortSignal.timeout(50)), /cancelled/)
})
