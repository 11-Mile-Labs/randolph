import type { MemoryCommand, LessonDraft, LessonRef } from '@randolph/runtime/contracts';
import { parseId } from './validation.js';
const object = (value: unknown): Record<string, unknown> => {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('Invalid memory request.');
  return value as Record<string, unknown>;
};
export function parseLessonRef(value: unknown): LessonRef {
  const input = object(value);
  if (!Number.isSafeInteger(input.version) || Number(input.version) < 1)
    throw new Error('Invalid lesson version.');
  return { lessonId: parseId(input.lessonId), version: Number(input.version) };
}
export function parseMemoryCommand(value: unknown): MemoryCommand {
  const input = object(value);
  if (JSON.stringify(input).length > 128_000) throw new Error('Memory request is too large.');
  const projectId = parseId(input.projectId);
  switch (input.action) {
    case 'create':
      return { projectId, action: 'create', draft: object(input.draft) as LessonDraft };
    case 'edit':
      return {
        projectId,
        action: 'edit',
        reference: parseLessonRef(input.reference),
        patch: object(input.patch),
      };
    case 'approve':
    case 'reject':
      if (
        !Array.isArray(input.references) ||
        !input.references.length ||
        input.references.length > 200
      )
        throw new Error('Choose lesson versions.');
      return { projectId, action: input.action, references: input.references.map(parseLessonRef) };
    case 'pin':
      if (typeof input.pinned !== 'boolean') throw new Error('Invalid pin choice.');
      return {
        projectId,
        action: 'pin',
        reference: parseLessonRef(input.reference),
        pinned: input.pinned,
      };
    case 'restore':
      if (!Number.isSafeInteger(input.sourceVersion) || Number(input.sourceVersion) < 1)
        throw new Error('Invalid source version.');
      return {
        projectId,
        action: 'restore',
        reference: parseLessonRef(input.reference),
        sourceVersion: Number(input.sourceVersion),
      };
    case 'settings': {
      if (input.scope !== 'project' && input.scope !== 'global')
        throw new Error('Invalid settings scope.');
      if (
        input.expectedRevision !== null &&
        (typeof input.expectedRevision !== 'string' ||
          !/^[0-9a-f]{64}$/.test(input.expectedRevision))
      )
        throw new Error('Invalid settings revision.');
      const settings = object(input.value);
      if (typeof settings.autoApprove !== 'boolean')
        throw new Error('Invalid approval preference.');
      const frameworks = object(settings.frameworks);
      if (Object.values(frameworks).some((version) => typeof version !== 'string'))
        throw new Error('Invalid framework version.');
      return {
        projectId,
        action: 'settings',
        scope: input.scope,
        expectedRevision: input.expectedRevision,
        value: {
          autoApprove: settings.autoApprove,
          frameworks: frameworks as Record<string, string>,
        },
      };
    }
    default:
      throw new Error('Unsupported memory action.');
  }
}
