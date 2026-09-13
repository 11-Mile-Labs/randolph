import { execFileSync } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { randomUUID } from "node:crypto";

export type Fixture = {
  root: string;
  repo: string;
  worktree: string;
  remote: string;
  baseline: string;
};

const markerName = ".randolph-fixture.json";
const owned = new Map<string, { fixture: Fixture; token: string; root: { dev: number; ino: number }; remote: { dev: number; ino: number } }>();

const inside = (parent: string, child: string): boolean => {
  const rel = relative(parent, child);
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${"/"}`) && !rel.startsWith("../") && !isAbsolute(rel));
};

const canonical = (path: string): string => {
  const requested = resolve(path);
  let existing = requested;
  const suffix: string[] = [];
  while (!existsSync(existing)) {
    suffix.unshift(existing.slice(existing.lastIndexOf("/") + 1));
    existing = dirname(existing);
  }
  return resolve(realpathSync.native(existing), ...suffix);
};

const identity = (path: string): { dev: number; ino: number } => {
  const stat = lstatSync(path);
  return { dev: stat.dev, ino: stat.ino };
};

const containingRepository = (path: string): string | undefined => {
  let ancestor = canonical(path);
  while (ancestor !== dirname(ancestor)) {
    if (existsSync(join(ancestor, ".git"))) return ancestor;
    ancestor = dirname(ancestor);
  }
  return undefined;
};

const safeRoot = (root: string, evidenceDir: string): { root: string; evidence: string } => {
  if (!isAbsolute(root) || !isAbsolute(evidenceDir)) throw new Error("fixture paths must be absolute");
  const requested = resolve(root);
  if (existsSync(requested)) throw new Error("fixture root must not pre-exist");
  const realRoot = canonical(requested);
  const evidence = canonical(evidenceDir);
  const cwd = canonical(process.cwd());
  const tempRoots = ["/tmp", "/private/tmp", "/var/tmp", tmpdir()].map(canonical);
  if (tempRoots.some((temp) => inside(temp, realRoot))) throw new Error("fixture root may not be under an OS temporary directory");
  if (inside(realRoot, cwd) || inside(cwd, realRoot)) throw new Error("fixture root may not contain or be inside the current repository");
  if (inside(realRoot, evidence) || inside(evidence, realRoot)) throw new Error("evidence must be outside the fixture");
  if (containingRepository(realRoot) || containingRepository(evidence)) throw new Error("fixture and evidence must be outside existing repositories");
  if (existsSync(evidenceDir) && lstatSync(evidenceDir).isSymbolicLink()) throw new Error("evidence path may not be a symlink");
  return { root: realRoot, evidence };
};

export function validateFixturePaths(root: string, evidenceDir: string): void {
  safeRoot(root, evidenceDir);
}

export function git(cwd: string, args: string[]): string {
  const cleanEnv = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("GIT_")));
  const env = {
    ...cleanEnv,
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_SYSTEM: "/dev/null",
    GIT_AUTHOR_NAME: "Randolph Fixture",
    GIT_AUTHOR_EMAIL: "fixture@example.invalid",
    GIT_COMMITTER_NAME: "Randolph Fixture",
    GIT_COMMITTER_EMAIL: "fixture@example.invalid",
    GIT_TERMINAL_PROMPT: "0",
  };
  return execFileSync("git", ["-c", "core.hooksPath=/dev/null", "-c", "commit.gpgsign=false", ...args], {
    cwd,
    env,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    timeout: 10000,
  }).trim();
}

export async function createFixture(root: string, evidenceDir: string): Promise<Fixture> {
  const paths = safeRoot(root, evidenceDir);
  const remote = join(paths.root, "remote.git");
  const repo = join(paths.root, "repo");
  const worktree = join(repo, ".worktrees", "run");
  const token = randomUUID();
  mkdirSync(repo, { recursive: true });
  try {
    writeFileSync(join(paths.root, markerName), JSON.stringify({ token, root: paths.root }) + "\n");
    git(paths.root, ["init", "--bare", remote]);
    git(repo, ["init", "-b", "main"]);
    writeFileSync(join(repo, ".gitignore"), ".worktrees/\nscratch/\n");
    mkdirSync(join(repo, ".worktrees"), { recursive: true });
    mkdirSync(join(repo, "src"), { recursive: true });
    mkdirSync(join(repo, "test"), { recursive: true });
    writeFileSync(join(repo, "src", "filter.mjs"), "export function searchFilter(items, query) {\n  if (!query.trim()) return [];\n  return items.filter((item) => item.includes(query));\n}\n");
    writeFileSync(join(repo, "test", "filter.test.mjs"), "import test from 'node:test';\nimport assert from 'node:assert/strict';\nimport { searchFilter } from '../src/filter.mjs';\nconst items = ['alpha', 'beta'];\ntest('empty query returns every item', () => assert.deepEqual(searchFilter(items, ''), items));\ntest('non-empty query filters items', () => assert.deepEqual(searchFilter(items, 'alp'), ['alpha']));\n");
    git(repo, ["add", ".gitignore", "src", "test"]);
    git(repo, ["commit", "-m", "baseline"]);
    const baseline = git(repo, ["rev-parse", "HEAD"]);
    git(repo, ["remote", "add", "origin", remote]);
    git(repo, ["push", "origin", "main"]);
    git(repo, ["worktree", "add", "-b", "feature/run", worktree, "main"]);
    mkdirSync(join(worktree, "scratch"), { recursive: true });
    writeFileSync(join(worktree, "scratch", "ignored.txt"), "disposable scratch\n");
    writeFileSync(join(worktree, "untracked.txt"), "fixture work starts here\n");
    writeFileSync(join(worktree, "artifact.bin"), Buffer.from([0, 1, 2, 3, 255]));
    symlinkSync(join(repo, ".git"), join(worktree, "protected-metadata"));
    const fixture: Fixture = { root: paths.root, repo, worktree, remote, baseline };
    owned.set(paths.root, { fixture, token, root: identity(paths.root), remote: identity(remote) });
    return fixture;
  } catch (error) {
    rmSync(paths.root, { recursive: true, force: true });
    throw error;
  }
}

export async function removeFixture(fixture: Fixture): Promise<void> {
  const record = owned.get(fixture.root);
  if (!record || record.fixture !== fixture) throw new Error("fixture is not owned by this process");
  const marker = join(fixture.root, markerName);
  if (!existsSync(marker) || JSON.parse(readFileSync(marker, "utf8")).token !== record.token || lstatSync(fixture.root).isSymbolicLink()) throw new Error("fixture ownership marker mismatch");
  if (JSON.stringify(identity(fixture.root)) !== JSON.stringify(record.root) || JSON.stringify(identity(fixture.remote)) !== JSON.stringify(record.remote)) throw new Error("fixture identity changed");
  rmSync(fixture.root, { recursive: true, force: false });
  owned.delete(fixture.root);
}

export function observeFixture(fixture: Fixture): { workHead: string; parentHead: string; remoteRefs: string } {
  return {
    workHead: git(fixture.worktree, ["rev-parse", "HEAD"]),
    parentHead: git(fixture.repo, ["rev-parse", "main"]),
    remoteRefs: git(fixture.remote, ["for-each-ref", "--format=%(refname):%(objectname)", "refs/heads"]),
  };
}
