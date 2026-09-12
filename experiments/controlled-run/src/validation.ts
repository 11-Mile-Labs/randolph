import { realpathSync } from 'node:fs';
import { hash } from './codex.js';

type Json = Record<string, any>;

export function validateEffectivePolicy(thread: Json, worktree: string): { matches: boolean; evidence: Json } {
  const policy = thread.sandbox;
  const canonical = (value: unknown): string | null => {
    try { return typeof value === 'string' ? realpathSync.native(value) : null; } catch { return null; }
  };
  const expected = canonical(worktree);
  const cwd = canonical(thread.cwd);
  const roots = policy?.writableRoots;
  const sources = thread.instructionSources;
  // Empty roots have no explicit cwd semantics in the generated native schema.
  // Remain conservative until that representation has a separate compatibility proof.
  const rootsMatch = Array.isArray(roots) && roots.length === 1 && canonical(roots[0]) === expected;
  const instructionsMatch = Array.isArray(sources) && sources.length === 0;
  const matches = expected !== null && cwd === expected && rootsMatch && instructionsMatch &&
    policy?.type === 'workspaceWrite' && policy.networkAccess === false &&
    policy.excludeTmpdirEnvVar === true && policy.excludeSlashTmp === true &&
    thread.approvalPolicy === 'on-request' && thread.approvalsReviewer === 'user' &&
    thread.activePermissionProfile == null;
  return { matches, evidence: { type: policy?.type, networkAccess: policy?.networkAccess,
    excludeTmpdirEnvVar: policy?.excludeTmpdirEnvVar, excludeSlashTmp: policy?.excludeSlashTmp,
    rootCount: Array.isArray(roots) ? roots.length : null, rootsMatch, cwdMatches: cwd === expected && expected !== null,
    cwdDigest: cwd ? hash(cwd) : null, instructionSourceCount: Array.isArray(sources) ? sources.length : null,
    instructionSourcesDigest: Array.isArray(sources) ? hash(JSON.stringify(sources)) : null,
    approvalPolicy: thread.approvalPolicy, approvalsReviewer: thread.approvalsReviewer,
    activeProfile: thread.activePermissionProfile?.id ?? null } };
}

export function baselineMatches(tests: { status: number | null; emptyPassed: boolean; nonemptyPassed: boolean },
  refs: { workHead: string; parentHead: string; remoteRefs: string }, baseline: string): boolean {
  return tests.status === 1 && !tests.emptyPassed && tests.nonemptyPassed &&
    refs.workHead === baseline && refs.parentHead === baseline && refs.remoteRefs === `refs/heads/main:${baseline}`;
}
