// Compares the program compiled from container/guard.c with linuxBindingFilter() over a large argument grid.
//   node packages/server/scripts/guard-differential.mjs [linux/arm64|linux/amd64]
// Builds the Dockerfile's gcc stage for the platform (needs a local Docker runtime and network for apt),
// dumps the compiled sock_filter array through a copy of guard.c that writes it to stdout and exits, then
// evaluates both programs. Exits 1 on any difference. The platform's binary is compiled, not run.
import { execFile, spawn } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { promisify } from 'node:util'
import { linuxBindingFilter } from '../src/native-agent/sandbox-protocol.ts'

const platform = process.argv[2] ?? 'linux/arm64'
const arch = { 'linux/arm64': 'arm64', 'linux/amd64': 'x64' }[platform]
if (!arch) throw new Error(`unsupported platform ${platform}`)
const audits = { arm64: 0xc00000b7, x64: 0xc000003e }
const directory = new URL('../src/native-agent/container/', import.meta.url).pathname
const tag = `guanxi-guard-differential:${arch}`
await promisify(execFile)('docker', ['build', '--quiet', '--target', 'build', '--platform', platform, '--tag', tag, directory], { maxBuffer: 1 << 24 })
const source = (await readFile(`${directory}guard.c`, 'utf8')).replace('  struct sock_fprog program',
  '  fwrite(rules, sizeof(rules[0]), sizeof(rules)/sizeof(rules[0]), stdout); return 0;\n  struct sock_fprog program')
if (!source.includes('fwrite(rules')) throw new Error('guard.c layout changed: cannot instrument')
const compiled = await new Promise((resolve, reject) => {
  const child = spawn('docker', ['run', '--rm', '-i', '--platform', platform, '--entrypoint', 'sh', tag, '-c',
    'cat > /g.c && gcc -w -O2 -include stdio.h /g.c -o /g && /g x'], { stdio: ['pipe', 'pipe', 'inherit'] })
  const chunks = []
  child.stdout.on('data', chunk => chunks.push(chunk)); child.on('error', reject)
  child.on('close', code => code === 0 ? resolve(Buffer.concat(chunks)) : reject(new Error(`dump failed ${code}`)))
  child.stdin.end(source)
})
await promisify(execFile)('docker', ['rmi', tag]).catch(() => undefined)

function verdict(program, nr, audit, args) {
  let accumulator = 0
  for (let pc = 0; pc < program.length / 8; pc++) {
    const code = program.readUInt16LE(pc * 8), yes = program[pc * 8 + 2], no = program[pc * 8 + 3], k = program.readUInt32LE(pc * 8 + 4)
    if (code === 0x20) accumulator = k === 0 ? nr : k === 4 ? audit : Number(BigInt(args[(k - 16) / 8] ?? 0) & 0xffffffffn)
    else if (code === 0x54) accumulator = (accumulator & k) >>> 0
    else if (code === 0x15) pc += accumulator === k ? yes : no
    else if (code === 0x35) pc += accumulator >= k ? yes : no
    else if (code === 0x45) pc += (accumulator & k) !== 0 ? yes : no
    else if (code === 0x06) return k
    else throw new Error(`unknown instruction ${code}`)
  }
  throw new Error('program ended without a verdict')
}
const generated = linuxBindingFilter(arch)
const values = [0, 1, 2, 3, 5, 10, 16, 17, 0x40, 0x41, 0x800, 0x80000, 0x80001, 0x80801, 0x100000001, 0x100000000, 0xffffffff, 0x80000000]
const numbers = [...Array(460).keys(), 0x3fffffff, 0x40000000, 0x40000001, 0x4000002f, 0x7fffffff, 0xffffffff]
let cases = 0, differences = 0
for (const audit of [audits[arch], 0, 0x40000003, audits[arch === 'arm64' ? 'x64' : 'arm64']]) for (const nr of numbers)
  for (const a0 of values) for (const a1 of values) for (const a2 of values.slice(0, 8)) for (const a3 of [0, 1, 2, 0x41, 0x100000001, 0x100000000]) {
    cases++
    if (verdict(compiled, nr, audit, [a0, a1, a2, a3]) !== verdict(generated, nr, audit, [a0, a1, a2, a3])) {
      if (++differences <= 5) console.error('DIFFERENCE', { audit, nr, a0, a1, a2, a3 })
    }
  }
console.log(`${platform}: guard ${compiled.length / 8} instructions, generated ${generated.length / 8}, ${cases} cases, ${differences} differences`)
process.exit(differences ? 1 : 0)
