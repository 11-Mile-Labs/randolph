# Durable checkpoints and history restoration

Status: implemented developer capability under the [working application plan](../plans/working-application.md). This document describes the bounded file-recovery increment; linked model Restart/rerun remains separate work.

## Automatic boundaries

Git conversation worktrees receive a checkpoint before native dispatch and after a completed turn. Failure to retain the starting checkpoint blocks dispatch. A completed turn whose later checkpoint fails remains completed, with a visible checkpoint error and its earlier checkpoint retained. Stopped or interrupted execution does not create a completed-turn checkpoint.

A retained checkpoint contains the exact eligible code tree, base Git history, run configuration and supplied lesson versions, conversation messages, current run events, and known delivery records. A self-contained object pack is verified without the source repository before publication. Files and the manifest are flushed before the record becomes recoverable; partial publication cannot be advertised as a ready checkpoint. No additional agent or approval is involved.

Non-Git folders and repositories without an initial commit still support read-only inspection, with an explicit warning that code recovery is unavailable. Code mode requires a managed Git worktree and refuses those roots. Supporting file recovery for these roots remains open.

## History and explicit restoration

**Run history** displays earlier runs, their messages, saved model/effort/context, checkpoint boundaries, and capture errors. The selected run also exposes its ordered activity timeline with expandable recorded event data and retained delivery outcomes, including checks, commit, merge target, and cleanup confirmation. Opening history never dispatches a turn.

**Restore files to folder** asks the user to select a destination parent through the native folder picker. The runtime creates a new directory, verifies the selected manifest digest and retained objects, and restores a standalone Git repository with detached base HEAD and the exact checkpoint working tree. Existing destinations are refused. The original database history, project, branch, review approvals, and external effects remain unchanged.

Restoration works after the original worktree and repository have been removed. It does not reconnect a provider session, retry delivery, push, or run model work. The retained external-action records are evidence, not execution instructions.

## Limits and remaining work

Snapshots preserve eligible tracked and untracked files, deletions, binary content, executable modes, and symlink targets. Ignored files, empty directories, outside-project resources, installed dependencies, credentials, and the surrounding operating environment are not reproduced. Unsupported entries or size limits fail explicitly. Current limits are 64 MiB per file, 512 MiB of snapshot content/object pack, 100,000 paths, and 1 MiB of structured metadata.

Explicit linked Restart/rerun, approval and external-effect reconciliation for those new runs, checkpointing later workflow/finalization steps, non-Git recovery, retention controls, and full lifecycle containment remain required v1 work. A successful file restore is not a complete execution restart or a complete-v1 claim.
