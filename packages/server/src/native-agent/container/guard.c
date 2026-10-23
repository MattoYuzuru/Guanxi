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
 * - io_uring_setup, io_uring_enter, io_uring_register: EPERM (IORING_OP_SOCKET would create sockets past
 *   the socket() rule; production must not depend on the runtime's default seccomp profile for this)
 * - sendto, recvfrom, sendmmsg, recvmmsg (flags = args[3]) and sendmsg, recvmsg (flags = args[2]):
 *   EPERM when the MSG_OOB bit is set in the low 32 bits. Unix-domain out-of-band data is the kernel
 *   surface (use-after-free and garbage-collector bugs) that holding both ends of a socketpair opens.
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
    /* 6-25 */ BLOCK(bind), BLOCK(listen), BLOCK(ptrace), BLOCK(process_vm_writev),
    BLOCK(unshare), BLOCK(setns), BLOCK(mount),
    BLOCK(io_uring_setup), BLOCK(io_uring_enter), BLOCK(io_uring_register),
    /* 26-29 flags in args[3] -> 33 */
    BPF_JUMP(BPF_JMP|BPF_JEQ|BPF_K, __NR_sendto, 6, 0), BPF_JUMP(BPF_JMP|BPF_JEQ|BPF_K, __NR_recvfrom, 5, 0),
    BPF_JUMP(BPF_JMP|BPF_JEQ|BPF_K, __NR_sendmmsg, 4, 0), BPF_JUMP(BPF_JMP|BPF_JEQ|BPF_K, __NR_recvmmsg, 3, 0),
    /* 30-31 flags in args[2] -> 35 */
    BPF_JUMP(BPF_JMP|BPF_JEQ|BPF_K, __NR_sendmsg, 4, 0), BPF_JUMP(BPF_JMP|BPF_JEQ|BPF_K, __NR_recvmsg, 3, 0),
    /* 32 */ BPF_JUMP(BPF_JMP|BPF_JEQ|BPF_K, __NR_socketpair, 4, 9), /* -> 37 pair / 42 socket */
    /* 33 */ BPF_STMT(BPF_LD|BPF_W|BPF_ABS, offsetof(struct seccomp_data, args[3])),
    /* 34 */ BPF_JUMP(BPF_JMP|BPF_JSET|BPF_K, MSG_OOB, 11, 12), /* -> 46 deny / 47 allow */
    /* 35 */ BPF_STMT(BPF_LD|BPF_W|BPF_ABS, offsetof(struct seccomp_data, args[2])),
    /* 36 */ BPF_JUMP(BPF_JMP|BPF_JSET|BPF_K, MSG_OOB, 9, 10), /* -> 46 deny / 47 allow */
    /* 37 */ BPF_STMT(BPF_LD|BPF_W|BPF_ABS, offsetof(struct seccomp_data, args[0])),
    /* 38 */ BPF_JUMP(BPF_JMP|BPF_JEQ|BPF_K, AF_UNIX, 0, 7), /* else -> 46 */
    /* 39 */ BPF_STMT(BPF_LD|BPF_W|BPF_ABS, offsetof(struct seccomp_data, args[1])),
    /* 40 */ BPF_STMT(BPF_ALU|BPF_AND|BPF_K, 0xf), /* SOCK_TYPE_MASK */
    /* 41 */ BPF_JUMP(BPF_JMP|BPF_JEQ|BPF_K, SOCK_STREAM, 5, 4), /* -> 47 allow / 46 deny */
    /* 42 */ BPF_JUMP(BPF_JMP|BPF_JEQ|BPF_K, __NR_socket, 0, 4), /* else -> 47 */
    /* 43 */ BPF_STMT(BPF_LD|BPF_W|BPF_ABS, offsetof(struct seccomp_data, args[0])),
    /* 44 */ BPF_JUMP(BPF_JMP|BPF_JEQ|BPF_K, AF_INET, 2, 0),
    /* 45 */ BPF_JUMP(BPF_JMP|BPF_JEQ|BPF_K, AF_INET6, 1, 0),
    /* 46 */ BPF_STMT(BPF_RET|BPF_K, DENY),
    /* 47 */ BPF_STMT(BPF_RET|BPF_K, SECCOMP_RET_ALLOW),
  };
  struct sock_fprog program = { .len = sizeof(rules)/sizeof(rules[0]), .filter = rules };
  if (prctl(PR_SET_NO_NEW_PRIVS, 1, 0, 0, 0) || prctl(PR_SET_SECCOMP, SECCOMP_MODE_FILTER, &program)) return 125;
  execvp(argv[1], argv + 1);
  return 125;
}
