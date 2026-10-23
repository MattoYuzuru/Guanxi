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

/**
 * Workload-only seccomp (classic BPF, little-endian `seccomp_data`): trusted proxy bridges
 * initialize before installation. This is the same policy as `container/guard.c`; keep them equal.
 *
 * - foreign audit architecture: kill the process; x32 and unknown ABI numbers (>= 0x40000000): EPERM
 * - bind, listen, ptrace, process_vm_writev, unshare, setns, mount: EPERM
 * - sendto, recvfrom, sendmmsg, recvmmsg (flags = args[3]) and sendmsg, recvmsg (flags = args[2]): EPERM when
 *   the MSG_OOB bit is set in the low 32 bits. Unix-domain out-of-band data is the kernel surface
 *   (use-after-free and garbage-collector bugs) that holding both ends of a socketpair opens.
 * - socket: only AF_INET and AF_INET6 (proxy traffic); AF_UNIX and everything else EPERM
 * - socketpair: only AF_UNIX with type SOCK_STREAM, flags masked off. Child-process stdio pipes
 *   (libuv, Python multiprocessing, test runners) need it. An anonymous stream pair is born
 *   connected, so `connect`/`sendto` on it cannot reach a pathname or abstract-name listener;
 *   a datagram pair could be re-connected and is therefore denied, with seqpacket and the rest.
 * - everything else: allowed (the container/bubblewrap layers own the remaining policy)
 */
export function linuxBindingFilter(arch: string): Buffer {
  const abi = arch === 'x64'
    ? { audit: 0xc000003e, blocked: [49, 50, 101, 311, 272, 308, 165], socket: 41, socketpair: 53,
      flagsAt3: [44, 45, 307, 299], flagsAt2: [46, 47] }
    : arch === 'arm64' ? { audit: 0xc00000b7, blocked: [200, 201, 117, 271, 97, 268, 40], socket: 198, socketpair: 199,
      flagsAt3: [206, 207, 269, 243], flagsAt2: [211, 212] } : null
  if (!abi) throw new Error('supervision_unavailable')
  const deny = 0x00050001, allow = 0x7fff0000, kill = 0x80000000
  const LD = 0x20, AND = 0x54, JEQ = 0x15, JGE = 0x35, JSET = 0x45, RET = 0x06, MSG_OOB = 1
  const AF_UNIX = 1, AF_INET = 2, AF_INET6 = 10, SOCK_STREAM = 1, SOCK_TYPE_MASK = 0xf
  const offset = { nr: 0, arch: 4, arg0: 16, arg1: 24, arg2: 32, arg3: 40 } // seccomp_data
  // Forward-only labels: a conditional names the instruction to continue at on true / false.
  type Step = { label?: string; code: number; yes?: string; no?: string; k: number }
  const steps: Step[] = [
    { code: LD, k: offset.arch }, { code: JEQ, k: abi.audit, yes: 'syscall', no: 'kill' },
    { label: 'syscall', code: LD, k: offset.nr }, { code: JGE, k: 0x40000000, yes: 'deny' },
    ...abi.blocked.map(nr => ({ code: JEQ, k: nr, yes: 'deny' })),
    ...abi.flagsAt3.map(nr => ({ code: JEQ, k: nr, yes: 'flags3' })), ...abi.flagsAt2.map(nr => ({ code: JEQ, k: nr, yes: 'flags2' })),
    { code: JEQ, k: abi.socketpair, yes: 'pair', no: 'socket' },
    { label: 'flags3', code: LD, k: offset.arg3 }, { code: JSET, k: MSG_OOB, yes: 'deny', no: 'allow' },
    { label: 'flags2', code: LD, k: offset.arg2 }, { code: JSET, k: MSG_OOB, yes: 'deny', no: 'allow' },
    { label: 'pair', code: LD, k: offset.arg0 }, { code: JEQ, k: AF_UNIX, yes: 'pair-type', no: 'deny' },
    { label: 'pair-type', code: LD, k: offset.arg1 }, { code: AND, k: SOCK_TYPE_MASK },
    { code: JEQ, k: SOCK_STREAM, yes: 'allow', no: 'deny' },
    { label: 'socket', code: JEQ, k: abi.socket, no: 'allow' },
    { code: LD, k: offset.arg0 }, { code: JEQ, k: AF_INET, yes: 'allow' }, { code: JEQ, k: AF_INET6, yes: 'allow' },
    { label: 'deny', code: RET, k: deny }, { label: 'allow', code: RET, k: allow }, { label: 'kill', code: RET, k: kill },
  ]
  const at = new Map(steps.flatMap((step, index) => step.label ? [[step.label, index] as const] : []))
  const bytes = Buffer.alloc(steps.length * 8)
  steps.forEach((step, index) => {
    // A conditional's omitted branch falls through to the next instruction.
    const jump = (label?: string) => {
      const distance = label === undefined ? 0 : at.get(label)! - index - 1
      if (!(distance >= 0 && distance <= 255)) throw new Error('supervision_unavailable')
      return distance
    }
    const conditional = step.code === JEQ || step.code === JGE || step.code === JSET
    bytes.writeUInt16LE(step.code, index * 8)
    bytes[index * 8 + 2] = conditional ? jump(step.yes) : 0
    bytes[index * 8 + 3] = conditional ? jump(step.no) : 0
    bytes.writeUInt32LE(step.k, index * 8 + 4)
  })
  return bytes
}
