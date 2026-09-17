import type { GitWorkspace } from './git-workspace-snapshot.js';

// The integration record shapes live here so integration-evidence.ts, integration-plan.ts and
// integration-apply.ts can share them without any of them referring back to integration.ts.
export type Entry = { mode: '100644' | '100755' | '120000'; oid: string };
export type RetainedEntry = Entry & { blobPath: string };
export type GitIntegrationFile = {
  path: string;
  before: RetainedEntry | null;
  after: RetainedEntry | null;
};
export type GitIntegrationPlan = {
  id: string;
  basis: GitWorkspace;
  sourceTreeOid: string;
  targetTreeOid: string;
  conflicts: string[];
  messages: string;
  truncated: boolean;
  evidenceDir: string;
  files: GitIntegrationFile[];
  indexPath: string;
  originalIndexPath: string;
  originalIndexHash: string;
  targetIndexPath: string;
  targetIndexHash: string;
};
export type GitIntegrationResult = {
  status: 'unchanged' | 'integrated' | 'conflicted';
  parentOid: string;
  treeOid: string;
  conflicts: string[];
  evidenceDir: string;
};
