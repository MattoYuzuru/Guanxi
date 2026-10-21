import { createHash } from 'node:crypto'
import { mkdir, writeFile, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { StringDecoder } from 'node:string_decoder'
import type { EgressScrubber } from '../egress/types.ts'
import { TOOL_OUTPUT_BYTES } from './sandbox-protocol.ts'

// JSON can expand one byte into six (for example a NUL escape).
const PAGE_BYTES = 8 * 1024
/** Private, session-scoped, scrubbed output artifacts; never exposed as writable roots. */
export class NativeOutputs {
  private directory: string
  private scrubber: EgressScrubber
  constructor(base: string, sessionId: string, scrubber: EgressScrubber) {
    this.directory = join(base, 'native-output', createHash('sha256').update(sessionId).digest('hex'))
    this.scrubber = scrubber
  }
  async bound(value: string): Promise<string> {
    const clean = this.scrubber.scrub(value)
    const data = Buffer.from(clean)
    if (data.length <= TOOL_OUTPUT_BYTES) return clean
    const id = createHash('sha256').update(data).digest('hex')
    await mkdir(this.directory, { recursive: true, mode: 0o700 })
    try { await writeFile(join(this.directory, id), data, { flag: 'wx', mode: 0o400 }) }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error }
    return JSON.stringify({ truncated: true, bytes: data.length, artifact: id, excerpt: data.subarray(0, PAGE_BYTES).toString('utf8'), readWith: 'tool_output_read' })
  }
  async read(id: string, offset: number): Promise<string> {
    if (!/^[a-f0-9]{64}$/.test(id) || !Number.isSafeInteger(offset) || offset < 0) throw new Error('path_denied')
    // Scrub the whole artifact before paging: a newly registered value can straddle pages.
    const clean = Buffer.from(this.scrubber.scrub(await readFile(join(this.directory, id), 'utf8')))
    const data = clean.subarray(offset, offset + PAGE_BYTES)
    const bytes = clean.length
    if (data.length && (data[0]! & 0xc0) === 0x80) throw new Error('path_denied')
    const text = new StringDecoder('utf8').write(data)
    const nextOffset = offset + Buffer.byteLength(text)
    return JSON.stringify({ artifact: id, offset, nextOffset, bytes, truncated: nextOffset < bytes, text: this.scrubber.scrub(text) })
  }
}
