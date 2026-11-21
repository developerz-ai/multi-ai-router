/* R=registered, P=prepare, A=lock-held readiness, S=activate, B=started, Q=retired. */
static int fenced;
static const char *lease_owner;
static long long lease_generation, lease_deadline;
static char renewal[128];
static size_t renewal_size;
static long long positive_decimal(const char *text) {
  if (!*text || strlen(text) > 19 || text[0] == '0') return -1;
  for (const char *p = text; *p; p++) if (*p < '0' || *p > '9') return -1;
  errno = 0;
  char *end;
  long long value = strtoll(text, &end, 10);
  return errno || *end || value <= 0 ? -1 : value;
}
/* The lease deadline is checked here on a monotonic clock, never by wall time or a JS timer, and
   every wait below re-checks it so an expired lease ends the guardian without the parent's help. */
static int lease_live(void) {
  long long now = milliseconds();
  return !fenced || (now >= 0 && now < lease_deadline);
}
static int configure_lease(char **args) {
  fenced = 1;
  lease_owner = args[0];
  lease_generation = positive_decimal(args[1]);
  lease_deadline = positive_decimal(args[2]);
  long long now = milliseconds();
  return uuid(lease_owner) && lease_generation > 0 && now >= 0 &&
      lease_deadline > now && lease_deadline - now <= 300000 ? 0 : -1;
}
/* Called with the stable local lock. Storage attachment is enforced outside this process: this
   lock is node-local, so it proves one writer on one host and never cross-node exclusion. */
static int adopt_generation(int state) {
  if (!fenced) return 0;
  if (!lease_live()) return -1;
  int fd = openat(state, "generation", O_RDONLY | O_NOFOLLOW | O_CLOEXEC);
  if (fd >= 0) {
    char text[128] = {0}, owner[37], generation[20], extra;
    struct stat st;
    ssize_t size = read(fd, text, sizeof(text) - 1);
    int valid = !fstat(fd, &st) && S_ISREG(st.st_mode) && st.st_nlink == 1 &&
                st.st_uid == geteuid() && !(st.st_mode & 077);
    close(fd);
    if (!valid || size <= 0 || size >= (ssize_t)sizeof(text) - 1 ||
        sscanf(text, "%36s %19s %c", owner, generation, &extra) != 2) return -1;
    long long previous = positive_decimal(generation);
    if (previous < 0 || previous > lease_generation ||
        (previous == lease_generation && strcmp(owner, lease_owner))) return -1;
    if (previous == lease_generation) return 0;
  } else if (errno != ENOENT) return -1;
  fd = openat(state, "generation.next", O_WRONLY | O_CREAT | O_TRUNC | O_NOFOLLOW | O_CLOEXEC, 0600);
  if (fd < 0) return -1;
  char text[128];
  int size = snprintf(text, sizeof(text), "%s %lld\n", lease_owner, lease_generation);
  int result = write(fd, text, size) == size && !fsync(fd) ? 0 : -1;
  close(fd);
  if (result || renameat(state, "generation.next", state, "generation") || fsync(state)) return -1;
  return lease_live() ? 0 : -1;
}
static int lock_exclusive(int lock) {
  int result;
  for (;;) {
    result = flock(lock, fenced ? LOCK_EX | LOCK_NB : LOCK_EX);
    if (result == 0) return lease_live() ? 0 : -1;
    if (fenced && (errno == EWOULDBLOCK || errno == EINTR) && lease_live() && !requested) {
      struct timespec delay = {.tv_nsec = 1000000};
      nanosleep(&delay, NULL);
      continue;
    }
    if (!fenced && errno == EINTR) continue;
    return result;
  }
}
static int retire_owner(int owners, const char *owner, int lock, int result) {
  /* Retirement is allowed after expiry, but only once all work is confirmed quiescent. */
  if (flock(lock, LOCK_EX) < 0) return 70;
  if (unlinkat(owners, owner, 0) < 0 || fsync(owners) < 0) return 70;
  if (write(3, "Q", 1) != 1) return 70;
  return result;
}
/* Nonblocking, bounded parser. A partial renewal never extends the old deadline. */
static int control_byte(char command) {
  if (renewal_size || command == 'U') {
    if (renewal_size >= sizeof(renewal) - 1) return -1;
    renewal[renewal_size++] = command;
    if (command != '\n') return 0;
    renewal[renewal_size] = 0;
    char owner[37], generation[20], deadline[20], extra;
    if (sscanf(renewal, "U %36s %19s %19s %c", owner, generation, deadline, &extra) != 3 ||
        strcmp(owner, lease_owner) || positive_decimal(generation) != lease_generation) return -1;
    long long next = positive_decimal(deadline);
    long long now = milliseconds();
    if (!lease_live() || next < lease_deadline || now < 0 || next - now > 300000) return -1;
    lease_deadline = next;
    renewal_size = 0;
    return 0;
  }
  return command;
}
static int receive_control(int timeout) {
  if (!lease_live() || requested) return -1;
  if (fenced) {
    long long remaining = lease_deadline - milliseconds();
    if (remaining <= 0) return -1;
    if (remaining < timeout || timeout < 0) timeout = remaining > INT_MAX ? INT_MAX : (int)remaining;
  }
  struct pollfd input = {.fd = 4, .events = POLLIN};
  int ready = poll(&input, 1, timeout);
  if (!lease_live() || requested || ready < 0) return -1;
  if (!ready) return 0;
  char command;
  if (read(4, &command, 1) != 1) return -1;
  return fenced ? control_byte(command) : command;
}
static int await_command(char expected, int timeout) {
  long long end = milliseconds() + timeout;
  for (;;) {
    long long left = end - milliseconds();
    if (left <= 0) return -1;
    int command = receive_control((int)left);
    if (command) return command == expected ? 0 : -1;
  }
}
static int prepare_activation(int state, int owners, const char *owner, int lock, int timeout) {
  if (flock(lock, LOCK_UN) < 0 || write(3, "R", 1) != 1) return 70;
  if (await_command('P', timeout)) return retire_owner(owners, owner, lock, 75);
  if (lock_exclusive(lock) < 0) return retire_owner(owners, owner, lock, 70);
  int deleted = present(state, "deleted");
  if (deleted != 0 || requested || adopt_generation(state))
    return retire_owner(owners, owner, lock, deleted > 0 ? 73 : 70);
  if (write(3, "A", 1) != 1) return 70;
  if (await_command('S', timeout) || !lease_live()) return retire_owner(owners, owner, lock, 75);
  return 0;
}
static int await_metadata_release(void) {
  for (;;) {
    int command = receive_control(-1);
    if (command == 'D') return 0;
    if (command < 0) return -1; /* Uncertain JS filesystem work retains its marker. */
    if (command) return -1;
  }
}
