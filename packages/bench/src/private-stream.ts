import type { Readable, Writable } from 'node:stream'
import { BenchChannelError, PrivateFrameDecoder, PrivateTrialChannel,
  type PrivateChannelHost, type PrivateChannelPolicy } from './private-channel.ts'

export interface PrivateStreamPolicy extends PrivateChannelPolicy {
  maximumInputChunkBytes: number
  outputTimeoutMs: number
}
export type PrivateStreamReason = 'channel_input_ended' | 'channel_input_closed' | 'channel_input_failed'
  | 'channel_input_invalid' | 'channel_input_too_large' | 'channel_output_failed'
  | 'channel_output_closed' | 'channel_output_timeout' | 'channel_aborted'
  | 'channel_request_invalid' | 'channel_frame_invalid' | 'channel_frame_too_large'
  | 'channel_frame_truncated' | 'channel_failed'
export interface PrivateStreamResult { reason: PrivateStreamReason; responsesDelivered: number }

const protocolErrors = new Set<PrivateStreamReason>(['channel_request_invalid', 'channel_frame_invalid',
  'channel_frame_too_large', 'channel_frame_truncated'])
function protocolReason(error: unknown): PrivateStreamReason {
  return error instanceof BenchChannelError && protocolErrors.has(error.message as PrivateStreamReason)
    ? error.message as PrivateStreamReason : 'channel_failed'
}

/** Bind one immutable capability to streams already owned by the coordinator. No process,
 * listener, peer authentication or credential transfer is created here. The caller owns the
 * upstream stream's allocation/high-water mark; oversized delivered chunks are refused. */
export async function servePrivateTrialStreams(input: Readable, output: Writable, host: PrivateChannelHost,
  policy: PrivateStreamPolicy, signal: AbortSignal): Promise<PrivateStreamResult> {
  if (!Number.isSafeInteger(policy.maximumInputChunkBytes) || policy.maximumInputChunkBytes <= 0 ||
    policy.maximumInputChunkBytes > 0x7fffffff || !Number.isSafeInteger(policy.outputTimeoutMs) ||
    policy.outputTimeoutMs <= 0 || policy.outputTimeoutMs > 0x7fffffff)
    throw new BenchChannelError('channel_policy_invalid')
  // Snapshot policy before any host await. The underlying channel copies its own policy.
  const maximumChunk = policy.maximumInputChunkBytes, outputTimeout = policy.outputTimeoutMs
  const channel = new PrivateTrialChannel(host, policy), decoder = new PrivateFrameDecoder(policy.maximumPayloadBytes)
  let phase: 'idle' | 'collecting' | 'writing' = 'idle', ended = false
  let result: PrivateStreamResult | undefined, responsesDelivered = 0
  let active: Promise<void> | undefined, cancelWrite: (() => void) | undefined
  let wake!: () => void
  const terminal = new Promise<void>(resolve => { wake = resolve })
  function stop(reason: PrivateStreamReason): void {
    if (result) return
    result = { reason, responsesDelivered }
    channel.close()
    cancelWrite?.()
    input.destroy(); output.destroy()
    wake()
  }
  const onAbort = () => stop('channel_aborted')
  const onInputError = () => stop('channel_input_failed')
  const onOutputError = () => stop('channel_output_failed')
  const onInputClose = () => { if (!ended) stop('channel_input_closed') }
  const onOutputClose = () => stop('channel_output_closed')
  function write(frame: Buffer): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      let finished = false
      const finish = (error?: Error) => {
        if (finished) return
        finished = true; clearTimeout(timer); cancelWrite = undefined
        if (error) reject(error)
        else resolve()
      }
      const timer = setTimeout(() => stop('channel_output_timeout'), outputTimeout)
      cancelWrite = () => finish(new BenchChannelError('channel_closed'))
      try {
        output.write(frame, error => {
          if (error) { stop('channel_output_failed'); finish(new BenchChannelError('channel_output_failed')) }
          else finish()
        })
      } catch { stop('channel_output_failed'); finish(new BenchChannelError('channel_output_failed')) }
    })
  }
  async function dispatch(raw: unknown): Promise<void> {
    try {
      const frame = await channel.handle(raw)
      if (result) return
      phase = 'writing'
      await write(frame)
      if (result) return
      responsesDelivered++
      phase = 'idle'
      if (channel.isClosed) stop('channel_failed')
      else if (ended) stop('channel_input_ended')
    } catch (error) { stop(protocolReason(error)) }
  }
  function onData(chunk: unknown): void {
    if (result) return
    if (!(chunk instanceof Uint8Array)) { stop('channel_input_invalid'); return }
    if (chunk.byteLength > maximumChunk) { stop('channel_input_too_large'); return }
    try {
      for (const raw of decoder.push(chunk)) {
        if (result) break
        if (phase !== 'idle') { stop('channel_request_invalid'); break }
        phase = 'collecting'
        active = dispatch(raw)
      }
    } catch (error) { stop(protocolReason(error)) }
  }
  function onEnd(): void {
    if (result) return
    ended = true
    try { decoder.finish() } catch (error) { stop(protocolReason(error)); return }
    // A response already retained and being written may finish on a half-closed input.
    // Pending inference/retention is canceled immediately, never hidden behind its await.
    if (phase !== 'writing') stop('channel_input_ended')
  }
  input.on('error', onInputError); input.on('close', onInputClose)
  output.on('error', onOutputError); output.on('close', onOutputClose)
  signal.addEventListener('abort', onAbort, { once: true })
  input.on('end', onEnd); input.on('data', onData)
  if (signal.aborted) onAbort()
  else if (input.destroyed || input.readableEnded) stop('channel_input_closed')
  else if (output.destroyed || output.writableEnded) stop('channel_output_closed')
  await terminal
  // Settlement is an acknowledgement, not a timer-based claim that host work has stopped.
  await channel.settled()
  await active
  signal.removeEventListener('abort', onAbort)
  input.off('data', onData); input.off('end', onEnd)
  // Destroyed Node streams can still deliver their pending error/close notifications.
  // Keep only content-free error handlers until close to avoid late unhandled errors.
  const cleanInput = () => { input.off('error', onInputError); input.off('close', onInputClose) }
  const cleanOutput = () => { output.off('error', onOutputError); output.off('close', onOutputClose) }
  if (input.closed) cleanInput(); else input.once('close', cleanInput)
  if (output.closed) cleanOutput(); else output.once('close', cleanOutput)
  return result!
}
