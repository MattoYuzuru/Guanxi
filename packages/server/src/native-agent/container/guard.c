/* Workload-only filter: the trusted stdio proxy binds before this is installed. */
#include <stddef.h>
#include <errno.h>
#include <unistd.h>
#include <sys/prctl.h>
#include <sys/syscall.h>
#include <sys/socket.h>
#include <linux/filter.h>
#include <linux/seccomp.h>
#include <linux/audit.h>
#if defined(__aarch64__)
#define NATIVE_ARCH AUDIT_ARCH_AARCH64
#elif defined(__x86_64__)
#define NATIVE_ARCH AUDIT_ARCH_X86_64
#else
#error Unsupported execution architecture
#endif
#define DENY SECCOMP_RET_ERRNO | EPERM
#define BLOCK(n) BPF_JUMP(BPF_JMP|BPF_JEQ|BPF_K, __NR_##n, 0, 1), BPF_STMT(BPF_RET|BPF_K, DENY)
/*
 * The same policy as linuxBindingFilter() in sandbox-protocol.ts; keep them equal.
 * - foreign audit architecture: kill; x32 and unknown ABI numbers (>= 0x40000000): EPERM
 * - bind, listen, ptrace, process_vm_writev, unshare, setns, mount: EPERM
 * - socket: only AF_INET and AF_INET6 (proxy traffic); AF_UNIX and everything else EPERM
 * - socketpair: only AF_UNIX with SOCK_STREAM, SOCK_CLOEXEC/SOCK_NONBLOCK masked off. libuv builds
 *   child stdio pipes from it. An anonymous stream pair is born connected, so connect() and
 *   sendto() on it cannot reach a pathname or abstract-name listener. A datagram pair can be
 *   re-connected, so datagram, seqpacket and every other pair is denied.
 * - everything else is allowed.
 * seccomp_data compares the low 32 bits of int arguments, exactly what the kernel uses.
 */
int main(int argc, char **argv) {
  if (argc < 2) return 125;
  struct sock_filter rules[] = {
    /* 0 */ BPF_STMT(BPF_LD|BPF_W|BPF_ABS, offsetof(struct seccomp_data, arch)),
    /* 1 */ BPF_JUMP(BPF_JMP|BPF_JEQ|BPF_K, NATIVE_ARCH, 1, 0),
    /* 2 */ BPF_STMT(BPF_RET|BPF_K, SECCOMP_RET_KILL_PROCESS),
    /* 3 */ BPF_STMT(BPF_LD|BPF_W|BPF_ABS, offsetof(struct seccomp_data, nr)),
    /* 4 */ BPF_JUMP(BPF_JMP|BPF_JGE|BPF_K, 0x40000000, 0, 1), /* x32 and unknown ABI */
    /* 5 */ BPF_STMT(BPF_RET|BPF_K, DENY),
    /* 6-19 */ BLOCK(bind), BLOCK(listen), BLOCK(ptrace), BLOCK(process_vm_writev),
    BLOCK(unshare), BLOCK(setns), BLOCK(mount),
    /* 20 */ BPF_JUMP(BPF_JMP|BPF_JEQ|BPF_K, __NR_socketpair, 0, 5), /* else -> 26 */
    /* 21 */ BPF_STMT(BPF_LD|BPF_W|BPF_ABS, offsetof(struct seccomp_data, args[0])),
    /* 22 */ BPF_JUMP(BPF_JMP|BPF_JEQ|BPF_K, AF_UNIX, 0, 7), /* else -> 30 */
    /* 23 */ BPF_STMT(BPF_LD|BPF_W|BPF_ABS, offsetof(struct seccomp_data, args[1])),
    /* 24 */ BPF_STMT(BPF_ALU|BPF_AND|BPF_K, 0xf), /* SOCK_TYPE_MASK */
    /* 25 */ BPF_JUMP(BPF_JMP|BPF_JEQ|BPF_K, SOCK_STREAM, 5, 4), /* -> 31 allow / 30 deny */
    /* 26 */ BPF_JUMP(BPF_JMP|BPF_JEQ|BPF_K, __NR_socket, 0, 4), /* else -> 31 */
    /* 27 */ BPF_STMT(BPF_LD|BPF_W|BPF_ABS, offsetof(struct seccomp_data, args[0])),
    /* 28 */ BPF_JUMP(BPF_JMP|BPF_JEQ|BPF_K, AF_INET, 2, 0),
    /* 29 */ BPF_JUMP(BPF_JMP|BPF_JEQ|BPF_K, AF_INET6, 1, 0),
    /* 30 */ BPF_STMT(BPF_RET|BPF_K, DENY),
    /* 31 */ BPF_STMT(BPF_RET|BPF_K, SECCOMP_RET_ALLOW),
  };
  struct sock_fprog program = { .len = sizeof(rules)/sizeof(rules[0]), .filter = rules };
  if (prctl(PR_SET_NO_NEW_PRIVS, 1, 0, 0, 0) || prctl(PR_SET_SECCOMP, SECCOMP_MODE_FILTER, &program)) return 125;
  execvp(argv[1], argv + 1);
  return 125;
}
