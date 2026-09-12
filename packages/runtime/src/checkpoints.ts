import { randomUUID } from 'node:crypto';
import { closeSync, constants, fsyncSync, mkdirSync, openSync, realpathSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import type { Run } from './contracts.js';
import { createCheckpoint, readCheckpoint, restoreCheckpoint, type CheckpointManifest } from './checkpoint-storage.js';
import { restoreCheckpointWorktree } from './checkpoint-workspace.js';
import { Store } from './store.js';

export type CheckpointRecord = {
  id: string; runId: string; digest: string; directory: string; createdAt: string;
  boundary: 'before-turn' | 'completed-turn'; baseCommitOid: string; snapshotTreeOid: string;
};
export type CheckpointInput = { runId: string; digest: string };
export type CheckpointRestore = { workspace: string; checkpoint: CheckpointRecord };

export class Checkpoints {
  constructor(private readonly store: Store) {}

  capture(run: Run, boundary: CheckpointRecord['boundary']): CheckpointRecord {
    const dataRoot = realpathSync(this.store.root);
    const runDirectory = join(dataRoot, relative(this.store.root, this.store.runDirectory(run)));
    if (realpathSync(runDirectory) !== runDirectory) throw new Error('Run evidence directory was redirected.');
    const directory = join(runDirectory, 'checkpoints');
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    if (realpathSync(directory) !== directory) throw new Error('Checkpoint directory was redirected.');
    // Flush directory entries for the newly created evidence hierarchy as well as its files.
    for (let path = directory; ; path = dirname(path)) {
      const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
      try { fsyncSync(fd); } finally { closeSync(fd); }
      if (path === dirname(dataRoot)) break;
    }
    const snapshot = this.store.snapshot();
    const recoveryMessages = run.recoveryMessages?.map((message, index) => ({ ...message, id: `${run.id}:recovery:${index}`, runId: run.id, conversationId: run.conversationId, createdAt: run.createdAt }));
    const newRecoveryMessages = boundary === 'completed-turn'
      ? snapshot.messages.filter(message => message.runId === run.id && message.role === 'assistant' && !message.id.startsWith(`${run.id}:recovery:`))
      : [];
    const manifest = createCheckpoint(run.workspace, directory, {
      schemaVersion: 1, boundary,
      run: { ...run, checkpoints: undefined },
      project: snapshot.projects.find(project => project.id === run.projectId),
      conversation: snapshot.conversations.find(conversation => conversation.id === run.conversationId),
      messages: recoveryMessages ? [...recoveryMessages, ...newRecoveryMessages] : snapshot.messages.filter(message => message.conversationId === run.conversationId),
      events: this.store.events(run.id),
      externalActions: snapshot.reviews.filter(review => review.conversationId === run.conversationId),
    });
    const checkpoint: CheckpointRecord = { id: randomUUID(), runId: run.id, directory: manifest.directory, digest: manifest.digest, createdAt: manifest.createdAt, boundary, baseCommitOid: manifest.baseCommitOid, snapshotTreeOid: manifest.snapshotTreeOid };
    run.checkpoints = [...(run.checkpoints ?? []), checkpoint];
    run.checkpointError = undefined;
    this.store.transaction(() => {
      this.store.putRun(run);
      this.store.append(run, 'checkpoint.saved', boundary === 'before-turn' ? 'Starting state retained in a recoverable checkpoint' : 'Completed work retained in a recoverable checkpoint', { checkpoint });
    });
    this.store.exportRun(run);
    return checkpoint;
  }

  failed(run: Run, error: unknown): void {
    run.checkpointError = error instanceof Error ? error.message : 'Checkpoint could not be retained.';
    this.store.transaction(() => { this.store.putRun(run); this.store.append(run, 'checkpoint.failed', run.checkpointError!); });
  }

  restore(input: CheckpointInput, destination: string): CheckpointRestore {
    const { checkpoint } = this.selected(input.runId, input.digest);
    const restored = restoreCheckpoint(checkpoint.directory, checkpoint.digest, destination);
    // A historical restore is an export, not a model dispatch or a delivery retry.
    return { workspace: restored.workspace, checkpoint };
  }

  selected(runId: string, digest: string): { run: Run; checkpoint: CheckpointRecord; manifest: CheckpointManifest } {
    const run = this.store.runs().find(candidate => candidate.id === runId);
    const checkpoint = run?.checkpoints?.find(candidate => candidate.digest === digest);
    if (!run || !checkpoint) throw new Error('This run does not contain the selected recoverable checkpoint.');
    return { run, checkpoint, manifest: readCheckpoint(checkpoint.directory, checkpoint.digest) };
  }

  restoreWorktree(runId: string, digest: string, projectRoot: string, workspaceId: string): { workspace: string; manifest: CheckpointManifest } {
    const { checkpoint } = this.selected(runId, digest);
    return restoreCheckpointWorktree(checkpoint.directory, checkpoint.digest, projectRoot, workspaceId);
  }
}
