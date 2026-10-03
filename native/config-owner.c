#define _GNU_SOURCE
#include <dirent.h>
#include <errno.h>
#include <fcntl.h>
#include <limits.h>
#include <poll.h>
#include <signal.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/file.h>
#include <sys/prctl.h>
#include <sys/stat.h>
#include <sys/syscall.h>
#include <sys/types.h>
#include <sys/wait.h>
#include <time.h>
#include <unistd.h>
/* Exit73 = deleted/refused;75 = safely deferred/capacity;70 = authority unavailable. */
static volatile sig_atomic_t requested;
static void request_stop(int signal) { requested = signal; }
#include "config-owner-state.h"
static long long milliseconds(void) {
  struct timespec t;
  if (clock_gettime(CLOCK_MONOTONIC, &t)) return -1;
  return (long long)t.tv_sec * 1000 + t.tv_nsec / 1000000;
}
static void signal_children(int signal, int maximum) {
  char path[PATH_MAX];
  snprintf(path, sizeof(path), "/proc/self/task/%ld/children", (long)getpid());
  FILE *children = fopen(path, "r");
  if (!children) return;
  long pid;
  int count = 0;
  while (count++ < maximum && fscanf(children, "%ld", &pid) == 1) {
    int pidfd = syscall(SYS_pidfd_open, (pid_t)pid, 0);
    if (pidfd < 0) continue;
    /* Bind signal to a pidfd and verify that its current process remains our adopted child. */
    char status_path[PATH_MAX], line[256];
    snprintf(status_path, sizeof(status_path), "/proc/%ld/status", pid);
    FILE *status = fopen(status_path, "r");
    long parent = -1;
    if (status) {
      while (fgets(line, sizeof(line), status))
        if (sscanf(line, "PPid:%ld", &parent) == 1) break;
      fclose(status);
    }
    if (parent == (long)getpid()) syscall(SYS_pidfd_send_signal, pidfd, signal, NULL, 0);
    close(pidfd);
  }
  fclose(children);
}
#include "config-owner-protocol.h"
int main(int argc, char **argv) {
  if (argc < 4 || !uuid(argv[3])) return 64;
  int root = open_root(argv[2]);
  if (root < 0) return 70;
  int namespace = directory(root, ".ownership");
  if (namespace < 0) return 70;
  int state = directory(namespace, argv[3]);
  if (state < 0) return 70;
  int owners = directory(state, "owners");
  if (owners < 0) return 70;
  if (fsync(namespace) || fsync(root) || fsync(state)) return 70;
  int lock = openat(state, "lock", O_CREAT | O_RDWR | O_NOFOLLOW | O_CLOEXEC, 0600);
  if (lock < 0) return 70;
  struct stat lock_stat;
  if (fstat(lock, &lock_stat) || !S_ISREG(lock_stat.st_mode) || lock_stat.st_uid != geteuid() ||
      lock_stat.st_nlink != 1 || (lock_stat.st_mode & 077))
    return 70;
  if (lock_exclusive(lock) < 0) return 75;
  if (!strcmp(argv[1], "revoke")) {
    int exists = present(state, "deleted");
    if (exists < 0) return 70;
    return exists || write_marker(state, "deleted") == 0 ? 0 : 70;
  }
  if (!strcmp(argv[1], "provision")) {
    int deleted = present(state, "deleted");
    if (deleted < 0) return 70;
    if (deleted) return 73;
    if (mkdirat(root, argv[3], 0700) < 0 && errno != EEXIST) return 70;
    int target = openat(root, argv[3], O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC);
    struct stat st;
    if (target < 0 || fstat(target, &st) || st.st_uid != geteuid() || fchmod(target, 0700) ||
        fsync(target) || fsync(root))
      return 70;
    close(target);
    return 0;
  }
  if (!strcmp(argv[1], "cleanup")) {
    if (argc != 6 || present(state, "deleted") != 1) return 70;
    int entries = number(argv[4]), depth = number(argv[5]);
    if (entries < 0 || depth < 0) return 64;
    int count = count_owners(owners, 1);
    if (count < 0) return 70;
    if (count) return 75;
    int target = openat(root, argv[3], O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC);
    if (target < 0) return errno == ENOENT ? 0 : 70;
    int result = erase_contents(target, depth, &entries);
    close(target);
    if (result) return result;
    return unlinkat(root, argv[3], AT_REMOVEDIR) == 0 && fsync(root) == 0 ? 0 : 70;
  }
  if ((strcmp(argv[1], "run") && strcmp(argv[1], "hold")) || argc < 11 || !uuid(argv[4])) return 64;
  int maximum = number(argv[5]), grace = number(argv[6]), poll_ms = number(argv[7]),
      max_children = number(argv[8]), admission = number(argv[9]);
  if (maximum < 0 || grace < 0 || poll_ms < 0 || max_children < 0 || admission < 0) return 64;
  int deleted = present(state, "deleted"), count = count_owners(owners, maximum);
  if (deleted < 0 || count < 0) return 70;
  if (deleted) return 73;
  int config = openat(root, argv[3], O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC);
  struct stat config_stat;
  if (config < 0 || fstat(config, &config_stat) || config_stat.st_uid != geteuid() ||
      (config_stat.st_mode & 077))
    return 70;
  if (count >= maximum) return 75;
  if (prctl(PR_SET_CHILD_SUBREAPER, 1) < 0) return 70;
  /* Fail closed when pidfd signaling required by cancellation is unavailable. */
  int own_pidfd = syscall(SYS_pidfd_open, getpid(), 0);
  if (own_pidfd < 0) return 70;
  close(own_pidfd);
  struct sigaction sa = {.sa_handler = request_stop};
  sigemptyset(&sa.sa_mask);
  if (sigaction(SIGTERM, &sa, NULL) || sigaction(SIGINT, &sa, NULL) ||
      sigaction(SIGUSR2, &sa, NULL))
    return 70;
  if (write_marker(owners, argv[4])) return 70;
  int gate = prepare_activation(state, owners, argv[4], lock, admission);
  if (gate) return gate;
  if (present(state, "deleted") != 0) return retire_owner(owners, argv[4], lock, 73);
  if (!strcmp(argv[1], "hold")) {
    if (write(3, "B", 1) != 1 || flock(lock, LOCK_UN) < 0) return 70;
    int released = await_metadata_release();
    return released ? 70 : retire_owner(owners, argv[4], lock, 0);
  }
  close(4);
  /* Revocation after readiness does not erase this registered owner's lifetime. */
  pid_t child = fork();
  if (child < 0) return 70;
  if (child == 0) {
    close(3);
    close(lock);
    close(owners);
    close(state);
    close(namespace);
    close(root);
    if (fchdir(config) < 0) _exit(70);
    close(config);
    execvp(argv[10], argv + 10);
    _exit(127);
  }
  if (write(3, "B", 1) != 1 || flock(lock, LOCK_UN) < 0) return 70;
  int primary = 0, status;
  long long deadline = -1;
  int killing = 0;
  for (;;) {
    if (requested) {
      if (requested == SIGUSR2) killing = 1;
      if (deadline < 0) {
        long long now = milliseconds();
        if (now < 0) return 70;
        deadline = now + grace;
      }
      requested = 0;
      signal_children(killing ? SIGKILL : SIGTERM, max_children);
    }
    pid_t got;
    while ((got = waitpid(-1, &status, WNOHANG)) > 0)
      if (got == child) primary = status;
    if (got < 0 && errno == ECHILD) break;
    if (got < 0 && errno != EINTR) return 70;
    long long now = milliseconds();
    if (now < 0) return 70;
    if (deadline >= 0 && now >= deadline) killing = 1;
    if (killing) signal_children(SIGKILL, max_children);
    struct timespec delay = {.tv_sec = poll_ms / 1000, .tv_nsec = (poll_ms % 1000) * 1000000L};
    nanosleep(&delay, NULL);
  }
  return retire_owner(owners, argv[4], lock,
                      WIFEXITED(primary) ? WEXITSTATUS(primary) : 128 + WTERMSIG(primary));
}
