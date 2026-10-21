import assert from 'node:assert/strict'
import { test } from 'node:test'
import { linuxBindingFilter } from '../../src/native-agent/sandbox-protocol.ts'

// Evaluate the generated classic BPF program against synthetic seccomp_data.
function verdict(filter: Buffer, arch: number, syscall: number, family = 2) {
  const data = new Map([[0, syscall], [4, arch], [16, family]])
  let accumulator = 0
  for (let pc = 0; pc < filter.length / 8; pc++) {
    const code = filter.readUInt16LE(pc * 8), yes = filter[pc * 8 + 2]!, no = filter[pc * 8 + 3]!, value = filter.readUInt32LE(pc * 8 + 4)
    if (code === 0x20) accumulator = data.get(value) ?? 0
    else if (code === 0x15) pc += accumulator === value ? yes : no
    else if (code === 0x35) pc += accumulator >= value ? yes : no
    else if (code === 0x06) return value
    else assert.fail('unknown BPF instruction')
  }
  assert.fail('filter must return a verdict')
}
for (const [arch, audit, syscalls, socket] of [
  ['x64', 0xc000003e, { bind: 49, listen: 50, ptrace: 101, process_vm_writev: 311, unshare: 272, setns: 308, mount: 165, socketpair: 53 }, 41],
  ['arm64', 0xc00000b7, { bind: 200, listen: 201, ptrace: 117, process_vm_writev: 271, unshare: 97, setns: 268, mount: 40, socketpair: 199 }, 198],
] as const) test(`Linux workload filter denies every container-guard syscall on ${arch}`, () => {
  const filter = linuxBindingFilter(arch)
  for (const [name, nr] of Object.entries(syscalls)) assert.equal(verdict(filter, audit, nr), 0x00050001, name)
  assert.equal(verdict(filter, audit, socket, 1), 0x00050001, 'AF_UNIX')
  assert.equal(verdict(filter, audit, socket, 2), 0x7fff0000, 'AF_INET proxy traffic')
  assert.equal(verdict(filter, audit, socket, 10), 0x7fff0000, 'AF_INET6 proxy traffic')
  assert.equal(verdict(filter, audit, 0), 0x7fff0000, 'ordinary syscall')
  assert.equal(verdict(filter, audit, 0x40000000), 0x00050001, 'x32/unknown ABI')
  assert.equal(verdict(filter, 0, 0), 0x80000000, 'foreign audit architecture')
})
