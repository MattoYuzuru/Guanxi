import assert from 'node:assert/strict'
import { test } from 'node:test'
import { linuxBindingFilter } from '../../src/native-agent/sandbox-protocol.ts'

const DENY = 0x00050001, ALLOW = 0x7fff0000, KILL = 0x80000000
const AF_UNIX = 1, AF_INET = 2, AF_INET6 = 10, AF_NETLINK = 16, AF_PACKET = 17
const SOCK_STREAM = 1, SOCK_DGRAM = 2, SOCK_RAW = 3, SOCK_SEQPACKET = 5, SOCK_CLOEXEC = 0x80000, SOCK_NONBLOCK = 0x800

// Evaluate the generated classic BPF program against synthetic seccomp_data. Reading any
// seccomp_data field the tests do not model fails the test rather than reading zero.
interface Call { nr: number; arch: number; args?: number[] }
function verdict(filter: Buffer, call: Call) {
  const args = call.args ?? []
  const data = new Map<number, number>([[0, call.nr], [4, call.arch], [16, args[0] ?? 0], [24, args[1] ?? 0]])
  let accumulator = 0
  for (let pc = 0; pc < filter.length / 8; pc++) {
    const code = filter.readUInt16LE(pc * 8), yes = filter[pc * 8 + 2]!, no = filter[pc * 8 + 3]!, value = filter.readUInt32LE(pc * 8 + 4)
    if (code === 0x20) { assert.ok(data.has(value), `unmodelled seccomp_data offset ${value}`); accumulator = data.get(value)! }
    else if (code === 0x54) accumulator = (accumulator & value) >>> 0
    else if (code === 0x15) pc += accumulator === value ? yes : no
    else if (code === 0x35) pc += accumulator >= value ? yes : no
    else if (code === 0x06) return value
    else assert.fail(`unknown BPF instruction ${code.toString(16)}`)
  }
  assert.fail('filter must return a verdict')
}

// Numbers and audit constants were read from the kernel headers of Debian bookworm (linux-libc-dev)
// by compiling a probe for each architecture, not copied from memory.
const abis = {
  x64: { audit: 0xc000003e, socket: 41, socketpair: 53, denied: { bind: 49, listen: 50, ptrace: 101, process_vm_writev: 311, unshare: 272, setns: 308, mount: 165 }, connect: 42 },
  arm64: { audit: 0xc00000b7, socket: 198, socketpair: 199, denied: { bind: 200, listen: 201, ptrace: 117, process_vm_writev: 271, unshare: 97, setns: 268, mount: 40 }, connect: 203 },
} as const

for (const [arch, abi] of Object.entries(abis) as [keyof typeof abis, typeof abis[keyof typeof abis]][]) {
  const filter = linuxBindingFilter(arch)
  const run = (nr: number, ...args: number[]) => verdict(filter, { nr, arch: abi.audit, args })
  const pair = (family: number, type: number) => run(abi.socketpair, family, type)
  const socket = (family: number, type = SOCK_STREAM) => run(abi.socket, family, type)

  test(`Linux workload filter denies every container-guard syscall on ${arch}`, () => {
    for (const [name, nr] of Object.entries(abi.denied)) assert.equal(run(nr, AF_INET, SOCK_STREAM), DENY, name)
    assert.equal(run(0), ALLOW, 'ordinary syscall')
    assert.equal(run(abi.connect, AF_INET), ALLOW, 'connect stays available to the proxy socket')
    assert.equal(verdict(filter, { nr: 0x40000000, arch: abi.audit }), DENY, 'x32/unknown ABI')
    assert.equal(verdict(filter, { nr: 0x40000000 + abi.socketpair, arch: abi.audit, args: [AF_UNIX, SOCK_STREAM] }), DENY, 'x32 socketpair')
    assert.equal(verdict(filter, { nr: 0, arch: 0 }), KILL, 'foreign audit architecture')
    assert.equal(verdict(filter, { nr: abi.socketpair, arch: 0x40000003, args: [AF_UNIX, SOCK_STREAM] }), KILL, 'i386 compat socketpair')
  })

  test(`socket() stays limited to AF_INET and AF_INET6 on ${arch}`, () => {
    assert.equal(socket(AF_UNIX), DENY, 'AF_UNIX stream')
    assert.equal(socket(AF_UNIX, SOCK_DGRAM), DENY, 'AF_UNIX datagram')
    assert.equal(socket(AF_UNIX, SOCK_SEQPACKET), DENY, 'AF_UNIX seqpacket')
    assert.equal(socket(AF_NETLINK, SOCK_RAW), DENY, 'AF_NETLINK')
    assert.equal(socket(AF_PACKET, SOCK_RAW), DENY, 'AF_PACKET')
    assert.equal(socket(AF_INET), ALLOW, 'AF_INET proxy traffic')
    assert.equal(socket(AF_INET6), ALLOW, 'AF_INET6 proxy traffic')
  })

  test(`socketpair() is limited to anonymous AF_UNIX stream pairs on ${arch}`, () => {
    assert.equal(pair(AF_UNIX, SOCK_STREAM), ALLOW, 'libuv stdio pipe')
    assert.equal(pair(AF_UNIX, SOCK_STREAM | SOCK_CLOEXEC), ALLOW, 'CLOEXEC')
    assert.equal(pair(AF_UNIX, SOCK_STREAM | SOCK_NONBLOCK), ALLOW, 'NONBLOCK')
    assert.equal(pair(AF_UNIX, SOCK_STREAM | SOCK_CLOEXEC | SOCK_NONBLOCK), ALLOW, 'both flags')
    // A datagram pair can be re-connected or sendto a pathname/abstract listener; seqpacket is unneeded.
    assert.equal(pair(AF_UNIX, SOCK_DGRAM), DENY, 'datagram')
    assert.equal(pair(AF_UNIX, SOCK_DGRAM | SOCK_CLOEXEC | SOCK_NONBLOCK), DENY, 'datagram with flags')
    assert.equal(pair(AF_UNIX, SOCK_SEQPACKET), DENY, 'seqpacket')
    assert.equal(pair(AF_UNIX, SOCK_RAW), DENY, 'raw')
    assert.equal(pair(AF_UNIX, 0), DENY, 'type zero')
    for (const family of [AF_INET, AF_INET6, AF_NETLINK, AF_PACKET, 0, 0x80000001]) assert.equal(pair(family, SOCK_STREAM), DENY, `family ${family}`)
  })

  test(`filter agrees with its reference model over a syscall, family and type grid on ${arch}`, () => {
    const denied = new Set<number>(Object.values(abi.denied))
    const model = (nr: number, family: number, type: number) => {
      if (denied.has(nr)) return DENY
      if (nr === abi.socketpair) return family === AF_UNIX && (type & 0xf) === SOCK_STREAM ? ALLOW : DENY
      if (nr === abi.socket) return family === AF_INET || family === AF_INET6 ? ALLOW : DENY
      return ALLOW
    }
    for (let nr = 0; nr < 450; nr++) for (const family of [0, AF_UNIX, AF_INET, AF_INET6, AF_NETLINK, AF_PACKET, 40])
      for (let base = 0; base < 16; base++) for (const flags of [0, SOCK_CLOEXEC, SOCK_NONBLOCK, SOCK_CLOEXEC | SOCK_NONBLOCK])
        assert.equal(run(nr, family, base | flags), model(nr, family, base | flags), `nr=${nr} family=${family} type=${base | flags}`)
  })

  test(`filter program is well formed on ${arch}`, () => {
    assert.equal(filter.length % 8, 0)
    const count = filter.length / 8
    assert.ok(count <= 4096, 'BPF_MAXINSNS')
    for (let pc = 0; pc < count; pc++) {
      const code = filter.readUInt16LE(pc * 8)
      if (code === 0x15 || code === 0x35) for (const offset of [filter[pc * 8 + 2]!, filter[pc * 8 + 3]!]) assert.ok(pc + 1 + offset < count, `jump from ${pc} leaves the program`)
    }
    assert.equal(filter.readUInt16LE((count - 1) * 8), 0x06, 'last instruction returns')
  })
}

test('filter generation refuses an unknown architecture', () => {
  assert.throws(() => linuxBindingFilter('ia32'), /supervision_unavailable/)
})
