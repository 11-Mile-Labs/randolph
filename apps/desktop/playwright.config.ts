import { defineConfig } from '@playwright/test';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
export default defineConfig({
  testDir: './test',
  testMatch: '**/*.spec.ts',
  workers: 1,
  // Whole-test budget. The coding acceptance alone takes about 30s on the
  // hosted macOS runner and 18s on a fast local Mac, so the previous 30s left
  // no margin and CI had to override it on the command line. It lives here now
  // so local and CI runs share one budget.
  timeout: 90_000,
  // Per-assertion poll window. Several waits in these specs cover real work
  // before the asserted text can render: harness discovery, dozens of
  // serialized Git spawns for workspace and checkpoint preparation, and a
  // scripted CLI turn. In a traced local run the wait that failed on CI took
  // 2.1s, and the slowest step, starting project checks, took about 5s from
  // click to asserted output. The hosted runner is about 1.7x slower at rest
  // and has repeatedly exceeded Playwright's 5s default under contention. 20s
  // gives the slowest step roughly 2x headroom at runner pace, while a genuine
  // hang still fails well inside the test budget.
  expect: { timeout: 20_000 },
  outputDir: join(tmpdir(), 'randolph-desktop-test-results'),
  reporter: 'list',
});
