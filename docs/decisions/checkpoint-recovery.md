# Durable checkpoints and history restoration

Status: implemented developer capability under the [working application plan](../plans/working-application.md). This document describes file restoration and explicit linked execution while the original related Git repository remains available.

## Automatic boundaries

Git conversation worktrees receive a checkpoint before native dispatch and after a completed turn. Failure to retain the starting checkpoint blocks dispatch. A completed turn whose later checkpoint fails remains completed, with a visible checkpoint error and its earlier checkpoint retained. Stopped or interrupted execution does not create a completed-turn checkpoint.

A retained checkpoint contains the exact eligible code tree, base Git history, run configuration and supplied lesson versions, conversation messages, current run events, and known delivery records. A self-contained object pack is verified without the source repository before publication. Files and the manifest are flushed before the record becomes recoverable; partial publication cannot be advertised as a ready checkpoint. No additional agent or approval is involved.

Non-Git folders and repositories without an initial commit still support read-only inspection, with an explicit warning that code recovery is unavailable. Code mode requires a managed Git worktree and refuses those roots. Supporting file recovery for these roots remains open.

## History and explicit restoration

**Run history** displays earlier runs, their messages, saved model/effort/context, checkpoint boundaries, and capture errors. The selected run also exposes its ordered activity timeline with expandable recorded event data and retained delivery outcomes, including checks, commit, merge target, and cleanup confirmation. Opening history never dispatches a turn.

**Restore files to folder** asks the user to select a destination parent through the native folder picker. The runtime creates a new directory, verifies the selected manifest digest and retained objects, and restores a standalone Git repository with detached base HEAD and the exact checkpoint working tree. Existing destinations are refused. The original database history, project, branch, review approvals, and external effects remain unchanged.

Restoration works after the original worktree and repository have been removed. It does not reconnect a provider session, retry delivery, push, or run model work. The retained external-action records are evidence, not execution instructions.

## Explicit linked execution

**Restart** is available for the latest interrupted run and its last safe checkpoint. Confirmation starts a new linked run in the same conversation, in a fresh managed worktree. **Rerun** accepts any retained checkpoint from completed, failed, or confirmed-stopped work and creates a new linked conversation. Both preserve the source run, its files, and its history.

The confirmation displays the selected checkpoint and saved model, effort, and mode. The runtime restores the exact retained tree and supplied conversation/lesson context before native dispatch. Interrupted partial output is retained for inspection but excluded from the replacement input. Repeated recovery and subsequent messages preserve that clean context without duplicating lesson text or the original prompt. Output can differ because execution starts a new native session.

Active work, uncertain process cleanup, and unresolved delivery/integration effects block recovery. Old approvals and push actions are not replayed; the new result requires fresh checks and approval. A failure before native dispatch is recorded and allows another explicit restart attempt when the source remains eligible. Opening history, cancelling confirmation, and reopening the application never start recovery.

Linked execution currently requires the original related Git repository. Deleted managed worktrees can be recreated at a fresh run-specific path, preserving other worktrees and their Git registrations. If the original repository is missing, standalone file restoration remains available, but restoring and re-adding that folder does not recreate the original conversation's execution identity.

## Verification

Real-Git tests cover retained bytes, modes, deletions, parent/index/sibling preservation, and deleted managed-directory restoration. Runtime tests cover saved configuration and context, linked identities, fresh review state, cleanup quarantine, and explicit retry after a pre-dispatch failure. Electron acceptance exercises confirmation/cancellation, same-conversation restart, linked-conversation rerun, unchanged source history and parent files, and reopening without dispatch. These tests use scripted adapters; native permission and lifecycle compatibility remain separate evidence.

## Limits and remaining work

Snapshots preserve eligible tracked and untracked files, deletions, binary content, executable modes, and symlink targets. Ignored files, empty directories, outside-project resources, installed dependencies, credentials, and the surrounding operating environment are not reproduced. Unsupported entries or size limits fail explicitly. Current limits are 64 MiB per file, 512 MiB of snapshot content/object pack, 100,000 paths, and 1 MiB of structured metadata.

Linked execution after original-repository loss, checkpointing later workflow/finalization steps, broader external-effect reconciliation, non-Git recovery, retention controls, and full lifecycle containment remain required v1 work. A successful file restore or linked execution does not complete v1.
