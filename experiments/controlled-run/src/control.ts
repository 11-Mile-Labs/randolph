export type ReviewBasis = { runId: string; revision: number; parentOid: string; contentDigest: string };
export type Approval = { action: 'final' | 'push' | 'intermediate'; source: 'human' | 'automatic';
  decision: 'approved' | 'denied'; basis: ReviewBasis };

export function requireApproval(action: 'final' | 'push', current: ReviewBasis, approval?: Approval): void {
  if (!approval || approval.source !== 'human' || approval.decision !== 'approved' || approval.action !== action) {
    throw new Error('Explicit action-specific human approval required');
  }
  for (const key of ['runId', 'revision', 'parentOid', 'contentDigest'] as const) {
    if (approval.basis[key] !== current[key]) throw new Error('Stale or mismatched approval');
  }
}
