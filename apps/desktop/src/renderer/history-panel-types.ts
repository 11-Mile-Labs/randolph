import type { CheckpointRecord } from '@randolph/runtime/contracts';

export type PendingRecovery = {
  checkpoint: CheckpointRecord;
  kind: 'restart' | 'rerun';
};
