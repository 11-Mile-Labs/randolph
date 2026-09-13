#include <libproc.h>
#include <errno.h>
#include <signal.h>
#include <stdio.h>
#include <stdlib.h>
#include <time.h>
#include <sys/proc_info.h>
#include <unistd.h>

#ifndef SZOMB
#define SZOMB 5
#endif

int main(int argc, char **argv) {
  pid_t *pids = NULL;
  int capacity = 0;
  int returned = 0;
  if (argc > 1) {
    capacity = argc - 1;
    pids = calloc((size_t)capacity, sizeof(*pids));
    if (pids == NULL) return 1;
    for (int i = 0; i < capacity; i++) {
      char *end = NULL;
      long value = strtol(argv[i + 1], &end, 10);
      if (*argv[i + 1] == '\0' || *end != '\0' || value <= 0 || value > 999999999L) { free(pids); return 1; }
      pids[i] = (pid_t)value;
    }
    returned = capacity;
  } else {
    int count = proc_listallpids(NULL, 0);
    if (count <= 0) { fprintf(stderr, "proc_listallpids failed\n"); return 1; }
    capacity = count + 256;
    pids = calloc((size_t)capacity, sizeof(*pids));
    if (pids == NULL) return 1;
    returned = proc_listallpids(pids, capacity * (int)sizeof(*pids));
    if (returned <= 0 || returned >= capacity) { fprintf(stderr, "proc_listallpids truncated or failed\n"); free(pids); return 1; }
  }
  fputs("[", stdout);
  int emitted = 0;
  for (int i = 0; i < returned; i++) {
    if (pids[i] == 0) continue;
    struct proc_bsdinfo info;
    int got = proc_pidinfo(pids[i], PROC_PIDTBSDINFO, 0, &info, sizeof(info));
    if (got != (int)sizeof(info)) {
      if (got == 0) {
        int probe = kill(pids[i], 0);
        if (probe == -1 && (errno == ESRCH || errno == EPERM)) continue;
        if (argc == 1) {
          struct timespec pause = { .tv_sec = 0, .tv_nsec = 1000000 };
          nanosleep(&pause, NULL);
          got = proc_pidinfo(pids[i], PROC_PIDTBSDINFO, 0, &info, sizeof(info));
        }
      }
      if (got != (int)sizeof(info)) {
        if (got < 0 && (errno == ESRCH || errno == EPERM)) continue;
        if (kill(pids[i], 0) == -1 && (errno == ESRCH || errno == EPERM)) continue;
        fprintf(stderr, "proc_pidinfo failed for pid %d\n", pids[i]);
        free(pids);
        return 1;
      }
    }
    if (emitted++) fputs(",", stdout);
    printf("{\"pid\":%d,\"ppid\":%d,\"pgid\":%d,\"uid\":%d,\"start\":\"%llu.%06llu\",\"zombie\":%s}",
      info.pbi_pid, info.pbi_ppid, info.pbi_pgid, info.pbi_uid,
      (unsigned long long)info.pbi_start_tvsec, (unsigned long long)info.pbi_start_tvusec,
      info.pbi_status == SZOMB ? "true" : "false");
  }
  fputs("]\n", stdout);
  free(pids);
  return 0;
}
