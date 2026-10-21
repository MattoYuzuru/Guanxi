import type { AccessMode } from '@guanxi/contract'
import { StringDecoder } from 'node:string_decoder'

export interface SandboxPolicy {
  mode: AccessMode
  scratch: string
  roots: string[]
  attachments: string[]
  protectedPaths: string[]
  domains: string[]
  runtimeBase?: string
  hiddenPaths?: string[]
  attachmentMetadata?: { path: string; mediaType: string; displayName: string }[]
}
export interface CommandResult { code: number | null; stdout: string; stderr: string; truncated: boolean }
export const TOOL_OUTPUT_BYTES = 64 * 1024

/** Decode once per stream, then budget the encoded text too (invalid UTF-8 can expand). */
export function commandOutput(code: number | null, out: Buffer[], err: Buffer[], truncated: boolean): CommandResult {
  let remaining = TOOL_OUTPUT_BYTES
  const decode = (parts: Buffer[]) => {
    const data = Buffer.from(Buffer.concat(parts).toString('utf8'))
    truncated ||= data.length > remaining
    const value = new StringDecoder('utf8').write(data.subarray(0, remaining))
    remaining -= Buffer.byteLength(value)
    return value
  }
  const stdout = decode(out), stderr = decode(err)
  return { code, stdout, stderr, truncated }
}

