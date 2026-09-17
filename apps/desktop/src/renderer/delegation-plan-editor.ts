import type { DelegationPlan, DelegationAssignment } from '@randolph/runtime/contracts';

export const same = (left: unknown, right: unknown): boolean =>
  JSON.stringify(left) === JSON.stringify(right);
export const clone = <T>(value: T): T => structuredClone(value);
export const rawLines = (value: string): string[] => value.split('\n');
export const normalizedLines = (value: string[]): string[] =>
  value.map((item) => item.trim()).filter(Boolean);
export const writeList = (value: string[]): string => value.join('\n');

export function normalizedPlan(plan: DelegationPlan): DelegationPlan {
  return {
    ...plan,
    assignments: plan.assignments.map((assignment) => {
      const { integrationInputs: rawIntegrationInputs, ...fields } = assignment;
      const integrationInputs = normalizedLines(rawIntegrationInputs ?? []);
      return {
        ...fields,
        dependencies: normalizedLines(assignment.dependencies),
        deliverables: normalizedLines(assignment.deliverables),
        completionCriteria: normalizedLines(assignment.completionCriteria),
        ...(integrationInputs.length ? { integrationInputs } : {}),
      };
    }),
  };
}

export function emptyAssignment(index: number): DelegationAssignment {
  return {
    id: `assignment-${index + 1}`,
    task: '',
    role: 'worker',
    harness: 'codex',
    executable: '',
    executableVersion: '',
    model: '',
    effort: '',
    rationale: '',
    dependencies: [],
    source: 'run-basis',
    mode: 'read-only',
    deliverables: [''],
    completionCriteria: [''],
  };
}

export function localErrors(plan: DelegationPlan): string[] {
  const normalized = normalizedPlan(plan);
  const errors: string[] = [];
  if (!normalized.assignments.length || normalized.assignments.length > 24)
    errors.push('Use between 1 and 24 assignments.');
  if (
    !normalized.limits.maxWorkers ||
    !normalized.limits.maxParallel ||
    !normalized.limits.maxAttempts ||
    !normalized.limits.activeMinutes
  )
    errors.push('Every execution limit must be a positive whole number.');
  if (normalized.limits.maxParallel > normalized.limits.maxWorkers)
    errors.push('Parallel workers cannot exceed worker limit.');
  const ids = new Set<string>();
  for (const assignment of normalized.assignments) {
    if (!assignment.id || ids.has(assignment.id))
      errors.push('Assignment IDs must be present and unique.');
    ids.add(assignment.id);
    if (
      ![
        assignment.task,
        assignment.executable,
        assignment.executableVersion,
        assignment.model,
        assignment.effort,
        assignment.rationale,
        assignment.source,
      ].every((value) => value.trim())
    )
      errors.push(`${assignment.id || 'Assignment'} has incomplete execution settings.`);
    if (!assignment.deliverables.length || !assignment.completionCriteria.length)
      errors.push(`${assignment.id || 'Assignment'} needs deliverables and completion criteria.`);
  }
  return [...new Set(errors)];
}
