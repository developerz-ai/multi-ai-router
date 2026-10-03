/* Internal rooted filesystem primitives; included by config-owner.c. */
static int number(const char *text) {
  char *end;
  long n = strtol(text, &end, 10);
  return !*text || *end || n <= 0 || n > INT_MAX ? -1 : (int)n;
}
static int uuid(const char *text) {
  if (strlen(text) != 36) return 0;
  for (int i = 0; i < 36; i++) {
    if (i == 8 || i == 13 || i == 18 || i == 23) {
      if (text[i] != '-') return 0;
    } else if (!((text[i] >= '0' && text[i] <= '9') || (text[i] >= 'a' && text[i] <= 'f')))
      return 0;
  }
  return 1;
}
static int directory(int parent, const char *name) {
  if (mkdirat(parent, name, 0700) < 0 && errno != EEXIST) return -1;
  int fd = openat(parent, name, O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC);
  struct stat st;
  if (fd < 0) return -1;
  if (fstat(fd, &st) || st.st_uid != geteuid() || (st.st_mode & 077)) {
    close(fd);
    return -1;
  }
  return fd;
}
static int open_root(const char *path) {
  char canonical[PATH_MAX];
  if (path[0] != '/' || !realpath(path, canonical) || strcmp(path, canonical)) return -1;
  return open(path, O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC);
}
static int present(int parent, const char *name) {
  struct stat st;
  return fstatat(parent, name, &st, AT_SYMLINK_NOFOLLOW) == 0 ? 1 : errno == ENOENT ? 0 : -1;
}
static int write_marker(int parent, const char *name) {
  int fd = openat(parent, name, O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW | O_CLOEXEC, 0600);
  if (fd < 0) return -1;
  int result = write(fd, "owned\n", 6) == 6 && fsync(fd) == 0 && fsync(parent) == 0 ? 0 : -1;
  close(fd);
  return result;
}
static int count_owners(int parent, int maximum) {
  int fd = openat(parent, ".", O_RDONLY | O_DIRECTORY | O_CLOEXEC);
  DIR *entries = fd < 0 ? NULL : fdopendir(fd);
  if (!entries) {
    if (fd >= 0) close(fd);
    return -1;
  }
  int count = 0;
  errno = 0;
  struct dirent *entry;
  while ((entry = readdir(entries))) {
    if (!strcmp(entry->d_name, ".") || !strcmp(entry->d_name, "..")) continue;
    if (++count >= maximum) break;
  }
  int failed = errno;
  closedir(entries);
  return failed ? -1 : count;
}
static int erase_contents(int fd, int depth, int *remaining) {
  if (depth <= 0) return 75;
  int scan = openat(fd, ".", O_RDONLY | O_DIRECTORY | O_CLOEXEC);
  DIR *entries = scan < 0 ? NULL : fdopendir(scan);
  if (!entries) {
    if (scan >= 0) close(scan);
    return 70;
  }
  int result = 0;
  struct dirent *entry;
  while ((entry = readdir(entries))) {
    if (!strcmp(entry->d_name, ".") || !strcmp(entry->d_name, "..")) continue;
    if (--*remaining < 0) {
      result = 75;
      break;
    }
    struct stat st;
    if (fstatat(fd, entry->d_name, &st, AT_SYMLINK_NOFOLLOW) < 0) {
      result = 70;
      break;
    }
    if (S_ISDIR(st.st_mode)) {
      int child = openat(fd, entry->d_name, O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC);
      if (child < 0) {
        result = 70;
        break;
      }
      result = erase_contents(child, depth - 1, remaining);
      close(child);
      if (result || unlinkat(fd, entry->d_name, AT_REMOVEDIR) < 0) {
        if (!result) result = 70;
        break;
      }
    } else if (unlinkat(fd, entry->d_name, 0) < 0) {
      result = 70;
      break;
    }
  }
  closedir(entries);
  return result;
}
