import { readYamlSettings, writeYamlSettings } from './yaml-settings.js';
import { parseProjectContext, type ProjectContext } from './project-context-validation.js';

export { parseProjectContext, type ProjectContext } from './project-context-validation.js';

export type ProjectContextSnapshot = {
  revision: string | null;
  value: ProjectContext;
  error?: string;
};

const emptyContext: ProjectContext = { purpose: '', instructions: '', documents: [] };

export function readProjectContext(root: string): ProjectContextSnapshot {
  const result = readYamlSettings(root, 'config.project.yaml', parseProjectContext, emptyContext);
  return {
    revision: result.revision,
    value: result.value,
    ...(result.error ? { error: result.error } : {}),
  };
}

export function writeProjectContext(
  root: string,
  value: ProjectContext,
  expectedRevision: string | null,
): ProjectContextSnapshot {
  const result = writeYamlSettings(
    root,
    'config.project.yaml',
    value,
    expectedRevision,
    parseProjectContext,
  );
  return {
    revision: result.revision,
    value: result.value,
    ...(result.error ? { error: result.error } : {}),
  };
}
