export type LessonScope = { kind: 'global' } | { kind: 'project'; projectId: string };
export type LessonRef = { lessonId: string; version: number };
export type LessonEvidence = { label: string; uri: string };
export type LessonApplicability = { framework: string; versions?: string[] };
export type LessonApprovalSettings = {
  projectAutoApprove: boolean;
  globalAutoApprove: boolean;
  revision?: string | null;
};
export type LessonDraft = {
  scope: LessonScope;
  title: string;
  text: string;
  tags?: string[];
  evidence?: LessonEvidence[];
  applicability?: LessonApplicability[];
};
export type LessonPatch = Partial<Omit<LessonDraft, 'scope'>>;
export type LessonVersion = LessonRef & {
  scope: LessonScope;
  title: string;
  text: string;
  tags: string[];
  evidence: LessonEvidence[];
  applicability: LessonApplicability[];
  status: 'draft' | 'approved' | 'rejected' | 'superseded';
  createdAt: string;
  updatedAt: string;
  approvalSettings: LessonApprovalSettings;
  approvedBy?: 'user' | 'setting';
  supersededBy?: LessonRef;
};
export type LessonEvent = {
  reference: LessonRef;
  action: 'created' | 'edited' | 'restored' | 'approved' | 'rejected' | 'superseded';
  at: string;
  previousStatus?: LessonVersion['status'];
  sourceVersion?: number;
  supersededBy?: LessonRef;
};
export type LessonRetrievalInput = {
  projectId: string;
  query?: string;
  tags?: string[];
  frameworks?: Record<string, string>;
  selected?: LessonRef[];
  limit?: number;
};
export type LessonRetrieval = {
  lessons: (LessonVersion & { reason: 'pinned' | 'selected' | 'matched' })[];
  blockedPins: { reference: LessonRef; reason: string }[];
  blockedSelections: { reference: LessonRef; reason: string }[];
  limitExceeded: boolean;
};
export type LessonUse = {
  projectId: string;
  runId: string;
  agentId: string;
  at: string;
  frameworks: Record<string, string>;
  lessons: LessonVersion[];
};
