/* Workload-only filter: the trusted stdio proxy binds before this is installed. */
#include <stddef.h>
#include <errno.h>
#include <unistd.h>
#include <sys/prctl.h>
#include <sys/syscall.h>
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
int main(int argc, char **argv) {
  if (argc < 2) return 125;
  struct sock_filter rules[] = {
    BPF_STMT(BPF_LD|BPF_W|BPF_ABS, offsetof(struct seccomp_data, arch)),
    BPF_JUMP(BPF_JMP|BPF_JEQ|BPF_K, NATIVE_ARCH, 1, 0),
    BPF_STMT(BPF_RET|BPF_K, SECCOMP_RET_KILL_PROCESS),
    BPF_STMT(BPF_LD|BPF_W|BPF_ABS, offsetof(struct seccomp_data, nr)),
    BLOCK(bind), BLOCK(listen), BLOCK(ptrace), BLOCK(process_vm_writev),
    BLOCK(unshare), BLOCK(setns), BLOCK(mount), BLOCK(socketpair),
    BPF_JUMP(BPF_JMP|BPF_JEQ|BPF_K, __NR_socket, 0, 5),
    BPF_STMT(BPF_LD|BPF_W|BPF_ABS, offsetof(struct seccomp_data, args[0])),
    BPF_JUMP(BPF_JMP|BPF_JEQ|BPF_K, 2, 2, 0), /* AF_INET */
    BPF_JUMP(BPF_JMP|BPF_JEQ|BPF_K, 10, 1, 0), /* AF_INET6 */
    BPF_STMT(BPF_RET|BPF_K, DENY),
    BPF_STMT(BPF_RET|BPF_K, SECCOMP_RET_ALLOW),
    BPF_STMT(BPF_RET|BPF_K, SECCOMP_RET_ALLOW),
  };
  struct sock_fprog program = { .len = sizeof(rules)/sizeof(rules[0]), .filter = rules };
  if (prctl(PR_SET_NO_NEW_PRIVS, 1, 0, 0, 0) || prctl(PR_SET_SECCOMP, SECCOMP_MODE_FILTER, &program)) return 125;
  execvp(argv[1], argv + 1);
  return 125;
}
