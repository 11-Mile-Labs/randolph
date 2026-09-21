import { readFileSync, realpathSync } from 'node:fs';
import { hash } from './codex.js';

type Json = Record<string, any>;

export function validateEffectivePolicy(
  thread: Json,
  worktree: string,
  version?: string,
  expectedInstructions: { path: string; digest: string }[] = [],
): { matches: boolean; evidence: Json } {
  const policy = thread.sandbox;
  const canonical = (value: unknown): string | null => {
    try {
      return typeof value === 'string' ? realpathSync.native(value) : null;
    } catch {
      return null;
    }
  };
  const expected = canonical(worktree);
  const cwd = canonical(thread.cwd);
  const roots = policy?.writableRoots;
  const sources = thread.instructionSources;
  // Codex rust-v0.149.0 grants ProjectRoots separately; writableRoots is additional access.
  // Version-pinned semantics: protocol/src/permissions.rs WorkspaceWrite conversion.
  const knownImplicitRoots = version === 'codex-cli 0.149.0';
  const rootsMatch =
    Array.isArray(roots) &&
    ((roots.length === 0 && knownImplicitRoots) ||
      (roots.length === 1 && canonical(roots[0]) === expected));
  const runtimeRoots = thread.runtimeWorkspaceRoots;
  const runtimeRootsMatch =
    Array.isArray(runtimeRoots) &&
    runtimeRoots.length === 1 &&
    canonical(runtimeRoots[0]) === expected;
  const instructionsMatch =
    Array.isArray(sources) &&
    sources.length === expectedInstructions.length &&
    sources.every((source: unknown, index: number) => {
      const expectedSource = expectedInstructions[index];
      if (!expectedSource || canonical(source) !== canonical(expectedSource.path)) return false;
      try {
        return hash(readFileSync(expectedSource.path, 'utf8')) === expectedSource.digest;
      } catch {
        return false;
      }
    });
  const matches =
    expected !== null &&
    cwd === expected &&
    rootsMatch &&
    runtimeRootsMatch &&
    instructionsMatch &&
    policy?.type === 'workspaceWrite' &&
    policy.networkAccess === false &&
    policy.excludeTmpdirEnvVar === true &&
    policy.excludeSlashTmp === true &&
    thread.approvalPolicy === 'on-request' &&
    thread.approvalsReviewer === 'user' &&
    thread.activePermissionProfile == null;
  return {
    matches,
    evidence: {
      type: policy?.type,
      networkAccess: policy?.networkAccess,
      excludeTmpdirEnvVar: policy?.excludeTmpdirEnvVar,
      excludeSlashTmp: policy?.excludeSlashTmp,
      rootSemantics: knownImplicitRoots
        ? 'v0.149.0-project-roots-plus-additional'
        : 'explicit-only',
      runtimeRootsMatch,
      runtimeRootCount: Array.isArray(runtimeRoots) ? runtimeRoots.length : null,
      runtimeRootsDigest: Array.isArray(runtimeRoots) ? hash(JSON.stringify(runtimeRoots)) : null,
      rootCount: Array.isArray(roots) ? roots.length : null,
      rootsMatch,
      cwdMatches: cwd === expected && expected !== null,
      cwdDigest: cwd ? hash(cwd) : null,
      instructionSourceCount: Array.isArray(sources) ? sources.length : null,
      instructionMode: expectedInstructions.length
        ? 'inventoried-global-present'
        : 'no-file-instructions',
      instructionContentDigests: expectedInstructions.map((source) => source.digest),
      instructionSourcesMatch: instructionsMatch,
      instructionSourcesDigest: Array.isArray(sources) ? hash(JSON.stringify(sources)) : null,
      approvalPolicy: thread.approvalPolicy,
      approvalsReviewer: thread.approvalsReviewer,
      activeProfile: thread.activePermissionProfile?.id ?? null,
    },
  };
}

export function baselineMatches(
  tests: { status: number | null; emptyPassed: boolean; nonemptyPassed: boolean },
  refs: { workHead: string; parentHead: string; remoteRefs: string },
  baseline: string,
): boolean {
  return (
    tests.status === 1 &&
    !tests.emptyPassed &&
    tests.nonemptyPassed &&
    refs.workHead === baseline &&
    refs.parentHead === baseline &&
    refs.remoteRefs === `refs/heads/main:${baseline}`
  );
}
