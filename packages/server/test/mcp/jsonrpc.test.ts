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

it('frames a response split across many chunks', async () => {
  const stdin = sink()
  const stdout = new PassThrough()
  const rpc = new JsonRpcConnection({
    stdin,
    stdout,
    maxMessageBytes: 1024,
    requestTimeoutMs: 1_000,
  })
  const pending = rpc.request('initialize')
  const response = `${JSON.stringify({
    jsonrpc: '2.0',
    id: 1,
    result: { ok: true, text: 'chunked'.repeat(20) },
  })}\n`
  for (let offset = 0; offset < response.length; offset += 3) {
    stdout.write(response.slice(offset, offset + 3))
  }

  assert.deepEqual(await pending, { ok: true, text: 'chunked'.repeat(20) })
  rpc.close()
  stdin.destroy()
  stdout.destroy()
})

it('truncates an untrusted server error message and drops its data', async () => {
  const stdin = sink()
  const stdout = new PassThrough()
  const rpc = new JsonRpcConnection({ stdin, stdout, requestTimeoutMs: 1_000 })
  const pending = rpc.request('tools/call')
  const secret = 'SENSITIVE-DATA-MARKER'
  const serverMessage = `${'E'.repeat(500)}SERVER-SECRET-TAIL`
  stdout.write(`${JSON.stringify({
    jsonrpc: '2.0',
    id: 1,
    error: { code: -32000, message: serverMessage, data: { secret } },
  })}\n`)

  const error = await expectCode(pending, 'mcp_rpc_error')
  assert.equal(error.rpcCode, -32000)
  const serverPart = error.message.replace(/^tools\/call failed: /, '')
  assert.ok(Array.from(serverPart).length <= 200)
  assert.equal(serverPart.includes('SERVER-SECRET-TAIL'), false)
  assert.equal((error as { data?: unknown }).data, undefined)
  assert.equal(error.message.includes(secret), false)

  rpc.close()
  stdin.destroy()
  stdout.destroy()
})

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
