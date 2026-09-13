import { posix } from 'node:path';

export type ProjectContext = {
  purpose: string;
  instructions: string;
  documents: Array<{ path: string; description: string }>;
};

const pathControlCharacter = (value: string): boolean => Array.from(value).some(character => {
  const code = character.charCodeAt(0);
  return code < 32 || code === 127;
});

const textControlCharacter = (value: string): boolean => Array.from(value).some(character => {
  const code = character.charCodeAt(0);
  return code < 9 || (code > 10 && code < 13) || (code > 13 && code < 32) || code === 127;
});

function text(value: unknown, field: string, max: number, required = false): string {
  if (typeof value !== 'string' || value.length > max || textControlCharacter(value)) {
    throw new Error(`Project context ${field} must be text of at most ${max} characters without control characters.`);
  }
  if (required && !value.trim()) throw new Error(`Project context ${field} must not be empty.`);
  return value;
}

function documentPath(value: unknown): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > 1024 || pathControlCharacter(value) || value.includes('\\') || value.startsWith('/')) {
    throw new Error('Project context document paths must be bounded POSIX relative paths without backslashes or control characters.');
  }
  const segments = value.split('/');
  if (segments.some(segment => segment === '..')) throw new Error('Project context document paths must not contain parent directory segments.');
  const normalized = posix.normalize(value);
  if (normalized === '.' || normalized.startsWith('../') || normalized.startsWith('/')) {
    throw new Error('Project context document paths must be bounded POSIX relative paths.');
  }
  return normalized;
}

export function parseProjectContext(value: unknown): ProjectContext {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Project context must be a YAML object.');
  const source = value as Record<string, unknown>;
  const purpose = text(source.purpose, 'purpose', 8000, true);
  const instructions = text(source.instructions, 'instructions', 16000);
  if (!Array.isArray(source.documents)) throw new Error('Project context documents must be an array.');
  if (source.documents.length > 30) throw new Error('Project context may contain at most 30 document references.');
  const paths = new Set<string>();
  const documents = source.documents.map(entry => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) throw new Error('Project context document entries must be objects.');
    const item = entry as Record<string, unknown>;
    const path = documentPath(item.path);
    if (paths.has(path)) throw new Error(`Project context contains duplicate document path: ${path}.`);
    paths.add(path);
    return { path, description: text(item.description, 'document descriptions', 2000) };
  });
  return { purpose, instructions, documents };
}
