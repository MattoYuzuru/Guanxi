import assert from 'node:assert/strict'
import { test } from 'node:test'
import { execFile } from 'node:child_process'
import { CONTAINER_IMAGE } from '../../src/native-agent/execution-owner.ts'
import { linuxBindingFilter } from '../../src/native-agent/sandbox-protocol.ts'

// Real-kernel checks of the workload seccomp policy, inside the execution image with the production
// container flags. Both implementations run: the compiled container guard and the generated
// linuxBindingFilter() program (installed here by a Perl prctl loader because the image's
// util-linux setpriv predates --seccomp-filter). Skipped when no container runtime or image exists.
const GUARD = '/usr/local/bin/guanxi-exec-guard'

interface Outcome { code: number | null; stdout: string; stderr: string }
function docker(args: string[], stdin = ''): Promise<Outcome> {
  return new Promise((resolve, reject) => {
    const child = execFile('docker', args, { timeout: 90_000, maxBuffer: 1 << 20 }, (error, stdout, stderr) => {
      if (error && (error as NodeJS.ErrnoException).code === 'ENOENT') reject(error)
      else resolve({ code: error ? ((error as { code?: unknown }).code as number ?? null) : 0, stdout, stderr })
    })
    child.stdin?.on('error', () => {})
    child.stdin?.end(stdin)
  })
}
type Discovery = { arch: 'arm64' | 'x64'; skip?: undefined } | { skip: string; arch?: undefined }
async function discover(): Promise<Discovery> {
  try {
    const probe = await docker(['run', '--rm', '--entrypoint', 'uname', CONTAINER_IMAGE, '-m'])
    if (probe.code !== 0) return { skip: 'container runtime or image unavailable' }
    const arch = probe.stdout.trim()
    if (arch === 'aarch64' || arch === 'x86_64') return { arch: arch === 'aarch64' ? 'arm64' as const : 'x64' as const }
    return { skip: `unsupported execution architecture ${arch || '(none)'}` }
  } catch { return { skip: 'no container runtime' } }
}
const found = await discover()
const skip = found.skip !== undefined ? `${found.skip} (provision ${CONTAINER_IMAGE} with packages/server/scripts/prepare-native-execution.sh)` : false
const arch: 'arm64' | 'x64' = found.arch ?? 'arm64'
const numbers = { arm64: { socket: 198, socketpair: 199, prctl: 167 }, x64: { socket: 41, socketpair: 53, prctl: 157 } }[arch]

// serve: stand-ins for host services the workload must not reach (pathname and abstract names,
// stream and datagram), started unfiltered and counting every connection or datagram they receive.
// probe: the workload side. exec: install the generated filter (env BPF), then exec the command.
const probe = String.raw`
use strict; use warnings; use Socket; use Errno; use IO::Select;
my ($mode, @rest) = @ARGV;
my %names = (fs_stream => '/tmp/svc.stream', fs_dgram => '/tmp/svc.dgram', abs_stream => "\0gx-stream", abs_dgram => "\0gx-dgram");
if ($mode eq 'serve') {
  my (%sock, %count); my $select = IO::Select->new;
  for my $name (sort keys %names) {
    my $type = $name =~ /stream/ ? SOCK_STREAM : SOCK_DGRAM;
    socket(my $s, AF_UNIX, $type, 0) or die "socket $name: $!"; bind($s, sockaddr_un($names{$name})) or die "bind $name: $!";
    listen($s, 8) or die "listen $name: $!" if $type == SOCK_STREAM;
    $sock{$name} = $s; $count{$name} = 0; $select->add($s);
  }
  open(my $ready, '>', '/tmp/ready') or die; close $ready;
  my $deadline = time + 40;
  while (!-e '/tmp/stop' && time < $deadline) {
    for my $s ($select->can_read(0.1)) {
      my ($name) = grep { $sock{$_} == $s } keys %sock;
      if ($name =~ /stream/) { if (accept(my $c, $s)) { close $c } } else { recv($s, my $buffer, 64, 0) }
      $count{$name}++;
    }
  }
  print "served $_=$count{$_}\n" for sort keys %count;
  exit 0;
}
sub filter { return pack('H*', $ENV{BPF}) }
sub install {
  my $program = filter(); my $instructions = length($program) / 8;
  syscall(${numbers.prctl}, 38, 1, 0, 0, 0) == 0 or die "no_new_privs: $!";
  syscall(${numbers.prctl}, 22, 2, pack('S x6 P', $instructions, $program)) == 0 or die "seccomp: $!";
}
install() if $ENV{BPF} && $mode ne 'serve';
exec(@rest) or die "exec: $!" if $mode eq 'exec';
sub result { my $ok = shift; return $ok ? 'ok' : $!{EPERM} ? 'EPERM' : 'err:' . ($!+0) }
sub pair { my ($family, $type) = @_; my $fds = "\0" x 8; return result(syscall(${numbers.socketpair}, $family, $type, 0, $fds) == 0) }
sub sock { my ($family, $type) = @_; my $fd = syscall(${numbers.socket}, $family, $type, 0); return result($fd >= 0) }
my ($cloexec, $nonblock) = (0x80000, 0x800);
my %out = (
  'pair.unix.stream' => pair(1, 1), 'pair.unix.stream.flags' => pair(1, 1 | $cloexec | $nonblock),
  'pair.unix.dgram' => pair(1, 2), 'pair.unix.dgram.flags' => pair(1, 2 | $cloexec | $nonblock),
  'pair.unix.seqpacket' => pair(1, 5), 'pair.unix.raw' => pair(1, 3),
  'pair.inet.stream' => pair(2, 1), 'pair.inet6.dgram' => pair(10, 2), 'pair.netlink.raw' => pair(16, 3),
  'socket.unix.stream' => sock(1, 1), 'socket.unix.dgram' => sock(1, 2), 'socket.unix.seqpacket' => sock(1, 5),
  'socket.inet.stream' => sock(2, 1), 'socket.inet6.stream' => sock(10, 1),
  'socket.netlink.raw' => sock(16, 3), 'socket.packet.raw' => sock(17, 3),
);
socket(my $tcp, AF_INET, SOCK_STREAM, 0) or die "inet socket: $!";
$out{'tcp.bind'} = result(bind($tcp, sockaddr_in(0, INADDR_LOOPBACK)));
$out{'tcp.listen'} = result(listen($tcp, 1));
# Whatever pair the workload can create, try to use it as a way to a service it must not reach.
for my $kind ([stream => SOCK_STREAM], [dgram => SOCK_DGRAM], [seqpacket => SOCK_SEQPACKET]) {
  my ($label, $type) = @$kind;
  my ($left, $right);
  if (!socketpair($left, $right, AF_UNIX, $type, 0)) { $out{"reach.$label.pair"} = result(0); next }
  $out{"reach.$label.pair"} = 'ok';
  syswrite($left, 'ping'); sysread($right, my $echo, 4); $out{"reach.$label.io"} = ($echo // '') eq 'ping' ? 'ok' : 'broken';
  for my $name (sort keys %names) {
    $out{"reach.$label.connect.$name"} = connect($left, sockaddr_un($names{$name})) ? 'CONNECTED' : 'refused';
    $out{"reach.$label.sendto.$name"} = send($left, 'x', 0, sockaddr_un($names{$name})) ? 'SENT' : 'refused';
  }
}
print "$_=$out{$_}\n" for sort keys %out;
`

async function inContainer(command: string, env: Record<string, string> = {}) {
  const shell = `cat > /tmp/probe.pl
perl /tmp/probe.pl serve > /tmp/served.txt 2>&1 &
i=0; while [ ! -e /tmp/ready ] && [ $i -lt 100 ]; do sleep 0.1; i=$((i+1)); done
${command}
touch /tmp/stop; wait; cat /tmp/served.txt`
  const result = await docker(['run', '--rm', '-i', '--network', 'none', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges',
    '--user', '1000:1000', '--read-only', '--tmpfs', '/tmp:exec,mode=1777', ...Object.entries(env).flatMap(([name, value]) => ['-e', `${name}=${value}`]),
    '--entrypoint', '/bin/sh', CONTAINER_IMAGE, '-c', shell], probe)
  const values = new Map<string, string>()
  for (const line of result.stdout.split('\n')) {
    const match = /^(served )?([\w.]+)=(.*)$/.exec(line)
    if (match) values.set(`${match[1] ? 'served.' : ''}${match[2]!}`, match[3]!)
  }
  return { ...result, values }
}
const shellQuote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`
const hex = (value: Buffer) => value.toString('hex')
const filterEnv = { BPF: hex(linuxBindingFilter(arch)) }
const implementations = [
  { name: 'container guard', command: `${GUARD} perl /tmp/probe.pl probe`, env: {} },
  { name: 'generated linuxBindingFilter', command: 'perl /tmp/probe.pl probe', env: filterEnv },
]
const reachNames = ['fs_stream', 'fs_dgram', 'abs_stream', 'abs_dgram']
const expectedPolicy: Record<string, string> = {
  'pair.unix.stream': 'ok', 'pair.unix.stream.flags': 'ok',
  'pair.unix.dgram': 'EPERM', 'pair.unix.dgram.flags': 'EPERM', 'pair.unix.seqpacket': 'EPERM', 'pair.unix.raw': 'EPERM',
  'pair.inet.stream': 'EPERM', 'pair.inet6.dgram': 'EPERM', 'pair.netlink.raw': 'EPERM',
  'socket.unix.stream': 'EPERM', 'socket.unix.dgram': 'EPERM', 'socket.unix.seqpacket': 'EPERM',
  'socket.inet.stream': 'ok', 'socket.inet6.stream': 'ok', 'socket.netlink.raw': 'EPERM', 'socket.packet.raw': 'EPERM',
  'tcp.bind': 'EPERM', 'tcp.listen': 'EPERM',
  'reach.stream.pair': 'ok', 'reach.stream.io': 'ok',
  'reach.dgram.pair': 'EPERM', 'reach.seqpacket.pair': 'EPERM',
}

for (const implementation of implementations) {
  test(`${implementation.name}: only anonymous AF_UNIX stream pairs are created; sockets, bind and listen stay denied`, { skip, timeout: 120_000 }, async () => {
    const { values, stderr } = await inContainer(implementation.command, implementation.env)
    for (const [name, expected] of Object.entries(expectedPolicy)) assert.equal(values.get(name), expected, `${name} ${stderr}`)
  })
  test(`${implementation.name}: a stream pair cannot reach any pathname or abstract listener, and no listener saw traffic`, { skip, timeout: 120_000 }, async () => {
    const { values, stderr } = await inContainer(implementation.command, implementation.env)
    for (const name of reachNames) {
      assert.equal(values.get(`reach.stream.connect.${name}`), 'refused', `connect ${name} ${stderr}`)
      assert.equal(values.get(`reach.stream.sendto.${name}`), 'refused', `sendto ${name} ${stderr}`)
      assert.equal(values.get(`served.${name}`), '0', `listener ${name} was reached`)
    }
  })
}

test('control: without the filter a datagram pair does reach a pathname and an abstract listener', { skip, timeout: 120_000 }, async () => {
  // Proves the probe discriminates, and why datagram, seqpacket and the other types stay denied.
  const { values, stderr } = await inContainer('perl /tmp/probe.pl probe')
  for (const name of ['fs_dgram', 'abs_dgram']) {
    assert.equal(values.get(`reach.dgram.connect.${name}`), 'CONNECTED', stderr)
    assert.equal(values.get(`reach.dgram.sendto.${name}`), 'SENT', stderr)
    assert.ok(Number(values.get(`served.${name}`)) >= 1, `listener ${name} saw ${values.get(`served.${name}`)}`)
  }
  assert.equal(values.get('socket.unix.stream'), 'ok', 'control must be able to create the sockets the policy denies')
  assert.equal(values.get('tcp.bind'), 'ok')
})

// Each file records its own pid and parent pid, so per-file subprocess isolation is observable.
const suiteFile = (name: string) => `cat > /tmp/fx/${name}.test.mjs <<'EOF'
import test from 'node:test'
import { appendFileSync } from 'node:fs'
test('${name}', () => { appendFileSync('/tmp/pids', process.pid + ' ' + process.ppid + '\\n') })
EOF`
const fixture = `mkdir -p /tmp/fx && cd /tmp/fx\n${suiteFile('a')}\n${suiteFile('b')}`
const pipes = String.raw`const { spawnSync, execFileSync, spawn } = require('node:child_process')
const sync = spawnSync('echo', ['piped'], { stdio: 'pipe' })
const echoed = execFileSync('cat', { input: 'both-ways' }).toString()
const child = spawn('sh', ['-c', 'echo async-out; echo async-err >&2'], { stdio: ['pipe', 'pipe', 'pipe'] })
let out = '', err = ''
child.stdout.on('data', d => out += d); child.stderr.on('data', d => err += d)
child.on('close', code => console.log(JSON.stringify({ sync: String(sync.stdout).trim(), error: sync.error?.code ?? null, echoed, out: out.trim(), err: err.trim(), code })))`
for (const [name, wrapper] of [['container guard', GUARD], ['generated linuxBindingFilter', 'perl /tmp/probe.pl exec']] as const) {
  const env = wrapper === GUARD ? {} : filterEnv
  test(`${name}: node spawns children with piped stdio`, { skip, timeout: 120_000 }, async () => {
    const { stdout, stderr } = await inContainer(`${wrapper} node -e ${shellQuote(pipes)}`, env)
    const line = stdout.split('\n').find(candidate => candidate.startsWith('{'))
    assert.ok(line, `no result: ${stdout} ${stderr}`)
    assert.deepEqual(JSON.parse(line), { sync: 'piped', error: null, echoed: 'both-ways', out: 'async-out', err: 'async-err', code: 0 })
  })
  test(`${name}: node --test runs a two-file suite with per-file subprocesses and no --test-isolation=none`, { skip, timeout: 120_000 }, async () => {
    const { stdout, stderr } = await inContainer(`${fixture}\n${wrapper} node --test --test-reporter=tap\necho ==PIDS==; cat /tmp/pids`, env)
    assert.match(stdout, /^# pass 2$/m, `${stdout} ${stderr}`)
    assert.match(stdout, /^# fail 0$/m, `${stdout} ${stderr}`)
    assert.doesNotMatch(stdout + stderr, /EPERM/)
    const files = stdout.split('==PIDS==\n')[1]!.split('\n').filter(line => /^\d+ \d+$/.test(line)).map(line => line.split(' ').map(Number))
    assert.equal(files.length, 2, `both files ran: ${stdout} ${stderr}`)
    assert.notEqual(files[0]![0], files[1]![0], 'each file ran in its own process')
    assert.equal(files[0]![1], files[1]![1], 'both are children of the one runner')
    assert.ok(files.every(([pid, parent]) => pid !== parent))
  })
}
