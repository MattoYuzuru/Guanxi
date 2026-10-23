import assert from 'node:assert/strict'
import { PassThrough, Writable } from 'node:stream'
import { it } from 'node:test'
import { JsonRpcConnection } from '../../src/mcp/jsonrpc.ts'
import { McpError, type McpErrorCode } from '../../src/mcp/types.ts'

function sink(): Writable {
  return new Writable({
    write(_chunk, _encoding, callback) {
      callback()
    },
  })
}

async function expectCode(promise: Promise<unknown>, code: McpErrorCode): Promise<McpError> {
  try {
    await promise
  } catch (error) {
    assert.ok(error instanceof McpError, `expected McpError ${code}, got ${String(error)}`)
    assert.equal(error.code, code)
    return error
  }
  assert.fail(`expected rejection with ${code}`)
}

it('fails an oversized frame before a newline arrives', async () => {
  const stdin = sink()
  const stdout = new PassThrough()
  const rpc = new JsonRpcConnection({
    stdin,
    stdout,
    maxMessageBytes: 64,
    requestTimeoutMs: 5_000,
  })
  const pending = rpc.request('tools/list')
  stdout.write(Buffer.alloc(65, 0x78))

  const error = await expectCode(pending, 'mcp_message_too_large')
  assert.match(error.message, /64-byte limit/)
  assert.equal(rpc.isClosed, true)
  assert.equal(stdout.writableEnded, false, 'the server stream must still be open')

  rpc.close()
  stdin.destroy()
  stdout.destroy()
})
