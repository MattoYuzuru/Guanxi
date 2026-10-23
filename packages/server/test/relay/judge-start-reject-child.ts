/** Child of judge-start.test.ts: an asynchronous judge source that rejects must not take the host process down. */
import { prepareStartJudge } from '../../src/relay/judge-start.ts'

try {
  prepareStartJudge((() => Promise.reject(new Error('host text at /Users/x/secret'))) as never, {} as never)
  console.log('not refused')
} catch (error) {
  console.log(`refused: ${(error as Error).message}`)
}
// A rejection with no handler would end the process here (default unhandled-rejection mode).
await new Promise(resolve => setTimeout(resolve, 200))
console.log('alive')
