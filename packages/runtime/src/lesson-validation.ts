import type {
  LessonApprovalSettings,
  LessonDraft,
  LessonRef,
  LessonVersion,
} from './lesson-types.js';

export const reference = (lesson: LessonVersion): LessonRef => ({
  lessonId: lesson.lessonId,
  version: lesson.version,
});
export const key = (ref: LessonRef): string => `${ref.lessonId}:${ref.version}`;
export function bounded(value: unknown, max: number, label: string): string {
  if (
    typeof value !== 'string' ||
    !value.trim() ||
    value.length > max ||
    value.includes(String.fromCharCode(0))
  )
    throw new Error(`Invalid ${label}.`);
  return value;
}
export function validateRef(ref: LessonRef): void {
  bounded(ref?.lessonId, 200, 'lesson identifier');
  if (!Number.isSafeInteger(ref.version) || ref.version < 1)
    throw new Error('Invalid lesson version.');
}
export function strings(value: unknown, maxItems: number, label: string): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > maxItems) throw new Error(`Invalid ${label}.`);
  return [...new Set(value.map((item) => bounded(item, 100, label).trim()))];
}
export function normalize(
  input: LessonDraft,
): Omit<
  LessonVersion,
  keyof LessonRef | 'createdAt' | 'updatedAt' | 'status' | 'approvalSettings'
> {
  const scope =
    input.scope?.kind === 'global'
      ? { kind: 'global' as const }
      : input.scope?.kind === 'project'
        ? {
            kind: 'project' as const,
            projectId: bounded(input.scope.projectId, 200, 'project identifier'),
          }
        : undefined;
  if (!scope) throw new Error('Invalid lesson scope.');
  if (!Array.isArray(input.evidence ?? []) || (input.evidence?.length ?? 0) > 20)
    throw new Error('Invalid lesson evidence.');
  const evidence = (input.evidence ?? []).map((item) => {
    const uri = bounded(item.uri, 2048, 'evidence link');
    if (!uri.startsWith('/') && !['http:', 'https:', 'randolph:'].includes(new URL(uri).protocol))
      throw new Error('Unsupported evidence link.');
    return { label: bounded(item.label, 200, 'evidence label'), uri };
  });
  if (!Array.isArray(input.applicability ?? []) || (input.applicability?.length ?? 0) > 20)
    throw new Error('Invalid lesson applicability.');
  const applicability = (input.applicability ?? []).map((item) => ({
    framework: bounded(item.framework, 100, 'framework').trim(),
    versions: strings(item.versions, 30, 'framework versions'),
  }));
  return {
    scope,
    title: bounded(input.title, 200, 'lesson title'),
    text: bounded(input.text, 16_000, 'lesson text'),
    tags: strings(input.tags, 32, 'lesson tags'),
    evidence,
    applicability,
  };
}
export function approvalSettings(value: LessonApprovalSettings): LessonApprovalSettings {
  if (
    !value ||
    typeof value.projectAutoApprove !== 'boolean' ||
    typeof value.globalAutoApprove !== 'boolean'
  )
    throw new Error('Explicit project and global approval settings are required.');
  if (value.revision !== undefined && value.revision !== null)
    bounded(value.revision, 256, 'approval settings revision');
  return {
    projectAutoApprove: value.projectAutoApprove,
    globalAutoApprove: value.globalAutoApprove,
    ...(value.revision !== undefined ? { revision: value.revision } : {}),
  };
}
export function contextFrameworks(
  value: Record<string, string> | undefined,
): Record<string, string> {
  if (value === undefined) return {};
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).length > 32)
    throw new Error('Invalid framework applicability context.');
  return Object.fromEntries(
    Object.entries(value).map(([framework, version]) => [
      bounded(framework, 100, 'framework'),
      bounded(version, 100, 'framework version'),
    ]),
  );
}
export function inScope(lesson: LessonVersion, projectId: string): boolean {
  return lesson.scope.kind === 'global' || lesson.scope.projectId === projectId;
}
export function applicable(lesson: LessonVersion, frameworks: Record<string, string>): boolean {
  return (
    !lesson.applicability.length ||
    lesson.applicability.some((rule) =>
      Object.entries(frameworks).some(
        ([framework, version]) =>
          framework.toLowerCase() === rule.framework.toLowerCase() &&
          (!rule.versions?.length || rule.versions.includes(version)),
      ),
    )
  );
}
