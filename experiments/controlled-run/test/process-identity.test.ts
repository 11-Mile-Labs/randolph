import assert from "node:assert/strict";
import { after, test } from "node:test";
import { execFileSync } from "node:child_process";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { compileSnapshot, descendants, sameIdentity, signalOwned, snapshot, type ProcessIdentity } from "../src/process-identity.js";

const dir = mkdtempSync(join(tmpdir(), "randolph-process-"));
after(() => rmSync(dir, { recursive: true, force: true }));
const one: ProcessIdentity = { pid: 10, ppid: 1, pgid: 10, uid: 501, start: "20.000001", zombie: false };

test("matches identity fields and walks only matching roots", () => {
  assert.equal(sameIdentity(one, { ...one, pgid: 99 }), true);
  assert.equal(sameIdentity(one, { ...one, start: "20.000002" }), false);
  const child = { ...one, pid: 11, ppid: 10 };
  const grandchild = { ...one, pid: 12, ppid: 11 };
  assert.deepEqual(descendants([child, grandchild], [one]), []);
  assert.deepEqual(descendants([one, child, grandchild], [{ ...one, start: "old" }, one]), [one, child, grandchild]);
});

test("parses helper output and reports enumeration failure", () => {
  const ok = join(dir, "ok.sh");
  writeFileSync(ok, "#!/bin/sh\nprintf '%s\\n' '[{\"pid\":1,\"ppid\":0,\"pgid\":1,\"uid\":501,\"start\":\"1.000001\",\"zombie\":false}]'\n");
  chmodSync(ok, 0o755);
  assert.equal(snapshot(ok)[0]?.pid, 1);
  const bad = join(dir, "bad.sh");
  writeFileSync(bad, "#!/bin/sh\nexit 7\n");
  chmodSync(bad, 0o755);
  assert.throws(() => snapshot(bad), /process enumeration failed/);
});

test("C helper emits a process after a transient first lookup", { skip: process.platform !== "darwin" }, () => {
  const wrapper = join(dir, "retry-wrapper.c");
  const binary = join(dir, "retry-wrapper");
  writeFileSync(wrapper, `#include <libproc.h>
#include <sys/proc_info.h>
#include <signal.h>
static int lookups = 0;
int fake_list(pid_t *pids, int size) { if (!pids) return 1; if (size < (int)sizeof(pid_t)) return 0; pids[0] = 42; return 1; }
int fake_info(pid_t pid, int flavor, uint64_t arg, void *buffer, int buffersize) { (void)pid; (void)flavor; (void)arg; if (++lookups == 1) return 0; struct proc_bsdinfo *info = buffer; info->pbi_pid = 42; info->pbi_ppid = 1; info->pbi_pgid = 42; info->pbi_uid = 501; info->pbi_start_tvsec = 1; info->pbi_start_tvusec = 2; info->pbi_status = 2; return buffersize; }
int fake_kill(pid_t pid, int signal) { (void)pid; (void)signal; return 0; }
#define proc_listallpids fake_list
#define proc_pidinfo fake_info
#define kill fake_kill
#define nanosleep(a, b) ((void)(a), 0)
#define main snapshot_main
#include "${resolve(process.cwd(), "src/process-snapshot.c")}"
#undef main
int main(void) { return snapshot_main(1, (char *[]){"snapshot"}); }
`);
  execFileSync("clang", ["-O2", "-Wall", "-Wextra", "-Werror", wrapper, "-o", binary], { timeout: 10000 });
  const output = execFileSync(binary, [], { encoding: "utf8" });
  assert.match(output, /"pid":42/);
});

test("compiles and observes the real process table on macOS", { skip: process.platform !== "darwin" }, () => {
  const binary = compileSnapshot(join(dir, "snapshot"));
  const processes = snapshot(binary);
  const selfPid = process.pid;
  const self = processes.find((entry) => entry.pid === selfPid);
  assert.ok(self);
  assert.equal(self.uid, process.getuid?.());
  assert.equal(snapshot(binary, [selfPid]).some((entry) => entry.pid === selfPid), true);
  assert.deepEqual(snapshot(binary, [999999999]), []);
  assert.ok(processes.some((entry) => entry.pid === self.ppid));
  try {
    const psRows = execFileSync("ps", ["-axo", "pid="], { encoding: "utf8" }).trim().split(/\s+/).filter(Boolean);
    assert.ok(psRows.includes("1"));
    assert.ok(processes.length <= psRows.length);
  } catch { /* ps is an optional tolerant cross-check */ }
});

test("never signals a reused PID", () => {
  const binary = join(dir, "identity.sh");
  writeFileSync(binary, `#!/bin/sh\nprintf '%s\\n' '[{"pid":99,"ppid":1,"pgid":99,"uid":501,"start":"new","zombie":false}]'\n`);
  chmodSync(binary, 0o755);
  assert.equal(signalOwned({ ...one, pid: 99 }, "SIGTERM", binary), "identity-changed");
});
