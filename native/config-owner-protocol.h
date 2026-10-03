/* R=registered, P=prepare, A=lock-held readiness, S=activate, B=started, Q=retired. */
static int lock_exclusive(int lock) {
  int result;
  do
    result = flock(lock, LOCK_EX);
  while (result < 0 && errno == EINTR);
  return result;
}
static int retire_owner(int owners, const char *owner, int lock, int result) {
  if (lock_exclusive(lock) < 0) return 70;
  if (unlinkat(owners, owner, 0) < 0 || fsync(owners) < 0) return 70;
  if (write(3, "Q", 1) != 1) return 70;
  return result;
}
static int await_command(char expected, int timeout) {
  struct pollfd input = {.fd = 4, .events = POLLIN};
  if (requested || poll(&input, 1, timeout) <= 0 || requested) return -1;
  char command = 0;
  return read(4, &command, 1) == 1 && command == expected ? 0 : -1;
}
static int prepare_activation(int state, int owners, const char *owner, int lock, int timeout) {
  if (flock(lock, LOCK_UN) < 0 || write(3, "R", 1) != 1) return 70;
  if (await_command('P', timeout)) return retire_owner(owners, owner, lock, 75);
  if (lock_exclusive(lock) < 0) return 70;
  int deleted = present(state, "deleted");
  if (deleted != 0 || requested) return retire_owner(owners, owner, lock, deleted > 0 ? 73 : 70);
  if (write(3, "A", 1) != 1) return 70;
  if (await_command('S', timeout)) return retire_owner(owners, owner, lock, 75);
  return 0; /* Own the stable lock through fork/hold activation. */
}
static int await_metadata_release(void) {
  char command;
  for (;;) {
    ssize_t count = read(4, &command, 1);
    if (count == 0 || (count == 1 && command == 'D')) return 0;
    if (count < 0 && errno == EINTR && !requested) continue;
    return -1; /* Unknown cancellation never retires a live router FS owner's marker. */
  }
}
