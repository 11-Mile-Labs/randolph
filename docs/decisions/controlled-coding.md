# Controlled coding and local delivery

Status: implemented developer capability under the [working application plan](../plans/working-application.md). The [complete product specification](../product-spec.md) remains the acceptance target.

## Execution

Conversations explicitly select Read-only or Code; each run retains its starting mode. Code requires an app-managed Git worktree and an authenticated, compatible installed Codex CLI. Compatibility currently identifies exactly CLI 0.149.0 and 0.154.0; prereleases and other versions remain unverified. See [0.154 compatibility evidence](../research/codex-0154-compatibility.md), including its failed-command event gap. There is no API fallback. Unknown versions fail capability checks before a coding turn.

Native thread and turn requests use workspace-write permissions restricted to the canonical conversation worktree, without network access, extra writable temporary roots, or approval-based elevation. The adapter verifies the effective native thread policy before dispatch. Ordinary file changes and command evidence are retained separately from assistant messages. Project checks use the same native command boundary without starting an inference turn or falling back to a host shell.

Worktree creation and runtime Git operations suppress repository hooks, filters, fsmonitor, and signing. Initial registration omits checkout; file checkout then resolves conditional filter configuration from inside the new worktree. These controls do not establish detached-descendant or owner-loss containment.

## Review and checks

Review captures the complete eligible worktree tree into Git objects with a separate temporary index. It includes tracked deletions, eligible untracked files, binary content, executable modes, and exact symlink target bytes. Real indexes and branch refs are unchanged. Displayed diffs are bounded and visibly marked if truncated. Unsupported path encodings, submodules, redirected identities, and nested repositories are rejected.

The desktop presents changed files, the combined diff, target branch/revision, check results, and explicit final approval. It shows the active check, elapsed time, and bounded output while verification runs. Supported detection covers declared pnpm lint/typecheck/build/test scripts, Go build/vet/test, and configured pytest. Unsupported package-manager declarations, missing checks, invalid/linked manifests, command failures, cancellation, and unconfirmed cleanup cannot produce a passing review.

Successful checks bind to the exact reviewed tree and parent. Changes after review or verification require a fresh review and checks. An advanced clean parent is integrated before fresh review; conflicts require explicit resolution confirmation and new checks. See [integration and push](memory-integration-and-push.md) for supported cases and limits. The delivery path requires the resulting worktree HEAD to match the parent. Unrelated uncommitted parent changes are preserved and currently block delivery, including unsaved-to-Git project settings.

## Approval and recovery

Final approval records deterministic commit bytes and their expected object ID before changing Git. Runtime operations independently reconcile commit creation, fast-forward merge, and worktree cleanup. Cleanup refuses late unreviewed edits. Approved delivery never pushes.

Reopening history starts no model turn and performs no delivery mutation. Interrupted delivery retains its plan and waits for explicit continuation. Reconciliation recognizes an existing commit and completed merge, preventing duplicate commits after an interrupted result write. Refreshing an unmerged review invalidates its previous approval; a merged delivery must be reconciled through cleanup rather than discarded.

Unconfirmed native run or check cleanup quarantines the conversation, including across repeated reopening. An interrupted check is not assumed terminated merely because the desktop restarted. This conservative state preserves the unresolved lifecycle boundary; a complete verified recovery mechanism remains required for v1.

## Evidence and limits

Real temporary Git tests cover exact trees, stale approvals, side-effect suppression, delivery reconciliation, cleanup preservation, and interrupted persistence. Runtime tests cover admission and cleanup uncertainty. Actual Electron acceptance covers Code mode, isolated editing, disabled pre-check approval, checks, final approval, local merge/cleanup, and history reopening without another turn. The CLI in desktop acceptance is scripted and consumes no inference.

A separate installed-native command proof exercised ordinary worktree edits and denied parent, Git metadata, commit, and push mutations; it also checked sanitized GUI-hosted toolchain execution. It used command RPCs without inference and retained local evidence outside the repository. This proof is version-specific and does not establish complete descendant containment.

Checkpoints/restart, all three harnesses, broader context/delegation, workflows/backlog, application lifetime controls, and distribution acceptance remain tracked in the working application plan. No public release or complete-v1 claim follows from this increment.
