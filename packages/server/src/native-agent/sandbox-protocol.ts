import type { AccessMode } from '@guanxi/contract'
import { StringDecoder } from 'node:string_decoder'

export interface SandboxPolicy {
  mode: AccessMode
  scratch: string
  roots: string[]
  attachments: string[]
  protectedPaths: string[]
  domains: string[]
  nodePorts?: number[]
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

/** Workload-only seccomp: trusted proxy bridges initialize before installation. */
export function linuxBindingFilter(arch: string): Buffer {
  const abi = arch === 'x64'
    ? { audit: 0xc000003e, blocked: [49, 50, 101, 311, 272, 308, 165, 53], socket: 41 }
    : arch === 'arm64' ? { audit: 0xc00000b7, blocked: [200, 201, 117, 271, 97, 268, 40, 199], socket: 198 } : null
  if (!abi) throw new Error('supervision_unavailable')
  const deny = 0x00050001, allow = 0x7fff0000
  const instructions = [[0x20, 0, 0, 4], [0x15, 1, 0, abi.audit], [0x06, 0, 0, 0x80000000],
    [0x20, 0, 0, 0], [0x35, 0, 1, 0x40000000], [0x06, 0, 0, deny],
    ...abi.blocked.flatMap(nr => [[0x15, 0, 1, nr], [0x06, 0, 0, deny]]),
    [0x15, 0, 5, abi.socket], [0x20, 0, 0, 16], // seccomp_data.args[0]
    [0x15, 2, 0, 2], [0x15, 1, 0, 10], [0x06, 0, 0, deny], [0x06, 0, 0, allow], [0x06, 0, 0, allow]]
  const bytes = Buffer.alloc(instructions.length * 8)
  instructions.forEach(([code, yes, no, value], index) => {
    bytes.writeUInt16LE(code!, index * 8); bytes[index * 8 + 2] = yes!; bytes[index * 8 + 3] = no!; bytes.writeUInt32LE(value!, index * 8 + 4)
  })
  return bytes
}
