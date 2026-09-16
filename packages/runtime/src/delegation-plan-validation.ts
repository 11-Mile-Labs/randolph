import { delegationPlanDigest } from './delegation-plan-digest.js';
import type {
  DelegationAssignment,
  DelegationAvailability,
  DelegationPlan,
  DelegationRole,
  DelegationValidation,
} from './delegation-plan.js';

function graphErrors(plan: DelegationPlan): string[] {
  const errors: string[] = [],
    nodes = new Map(plan.assignments.map((node) => [node.id, node]));
  if (nodes.size !== plan.assignments.length) errors.push('Assignment IDs must be unique.');
  const roles = (role: DelegationRole) => plan.assignments.filter((node) => node.role === role);
  if (!roles('worker').length) errors.push('A delegation plan requires a worker assignment.');
  if (roles('main-synthesis').length !== 1)
    errors.push('A delegation plan requires exactly one main-synthesis assignment.');
  const hasCode = plan.assignments.some((node) => node.mode === 'code');
  for (const role of ['main-integration', 'runtime-verification'] as const)
    if (hasCode && roles(role).length !== 1)
      errors.push(`A code delegation plan requires exactly one ${role} assignment.`);
    else if (!hasCode && roles(role).length)
      errors.push(`${role} is not permitted in a read-only delegation plan.`);
  if (roles('worker').length + roles('review').length > plan.limits.maxWorkers)
    errors.push('Worker and review assignments exceed maxWorkers.');
  for (const node of plan.assignments) {
    if (new Set(node.dependencies).size !== node.dependencies.length)
      errors.push(`${node.id} has duplicate dependencies.`);
    for (const dependency of node.dependencies)
      if (!nodes.has(dependency))
        errors.push(`${node.id} depends on unknown assignment ${dependency}.`);
    if (node.source.startsWith('output:')) {
      const producerId = node.source.slice('output:'.length),
        producer = nodes.get(producerId);
      if (!producer) errors.push(`${node.id} selects an unknown source output.`);
      else {
        if (!node.dependencies.includes(producerId))
          errors.push(`${node.id} must explicitly depend on its source output ${producerId}.`);
        if (!producer.producesSource)
          errors.push(
            `${node.id} selects ${producerId}, which does not produce an immutable source snapshot.`,
          );
      }
    }
    if (node.role === 'worker' && node.mode === 'code' && !node.producesSource)
      errors.push(`${node.id} is a code writer and must produce an immutable source snapshot.`);
    if (node.role === 'main-integration') {
      if (node.mode !== 'code' || !node.producesSource || !node.integrationInputs?.length)
        errors.push(
          'Main integration must be a code writer, produce a source snapshot, and declare explicit writer integration inputs.',
        );
      if (
        node.integrationInputs &&
        new Set(node.integrationInputs).size !== node.integrationInputs.length
      )
        errors.push('Main integration cannot repeat an integration input.');
      for (const input of node.integrationInputs ?? []) {
        const writer = nodes.get(input);
        if (!writer || writer.role !== 'worker' || writer.mode !== 'code' || !writer.producesSource)
          errors.push(
            `Integration input ${input} must identify a code worker immutable source output.`,
          );
        if (!node.dependencies.includes(input))
          errors.push(`Main integration must explicitly depend on integration input ${input}.`);
      }
    }
    if (
      node.role === 'runtime-verification' &&
      (!node.producesSource ||
        node.mode !== 'code' ||
        !node.source.startsWith('output:') ||
        nodes.get(node.source.slice(7))?.role !== 'main-integration')
    )
      errors.push(
        'Runtime verification must check the main integration output and produce a checked source snapshot.',
      );
    if (node.role === 'review' && node.mode !== 'read-only')
      errors.push('Review must be read-only.');
    if (
      node.role === 'review' &&
      hasCode &&
      (!node.source.startsWith('output:') ||
        nodes.get(node.source.slice(7))?.role !== 'runtime-verification')
    )
      errors.push(
        'Code review must follow runtime verification; code review before checks is invalid.',
      );
    if (node.role === 'main-synthesis' && (node.mode !== 'read-only' || node.producesSource))
      errors.push('Main synthesis must be read-only and cannot produce a source snapshot.');
  }
  const visiting = new Set<string>(),
    visited = new Set<string>();
  const visit = (node: DelegationAssignment): void => {
    if (visiting.has(node.id)) {
      errors.push('Assignment dependencies must be acyclic.');
      return;
    }
    if (visited.has(node.id)) return;
    visiting.add(node.id);
    node.dependencies.forEach((dependency) => {
      const next = nodes.get(dependency);
      if (next) visit(next);
    });
    visiting.delete(node.id);
    visited.add(node.id);
  };
  plan.assignments.forEach(visit);
  if (hasCode) {
    const integration = roles('main-integration')[0],
      verification = roles('runtime-verification')[0],
      synthesis = roles('main-synthesis')[0];
    for (const writer of roles('worker').filter((node) => node.mode === 'code'))
      if (!integration?.integrationInputs?.includes(writer.id))
        errors.push(
          `Code worker ${writer.id} is not included in the final integration source lineage.`,
        );
    if (
      synthesis &&
      (!synthesis.source.startsWith('output:') || synthesis.source.slice(7) !== verification?.id)
    )
      errors.push(
        'Code-plan synthesis must use the final checked verification output as its source.',
      );
  }
  const synthesis = roles('main-synthesis')[0];
  if (synthesis) {
    const ancestors = new Set<string>();
    const collect = (node: DelegationAssignment): void => {
      for (const dependency of node.dependencies)
        if (!ancestors.has(dependency)) {
          ancestors.add(dependency);
          const predecessor = nodes.get(dependency);
          if (predecessor) collect(predecessor);
        }
    };
    collect(synthesis);
    for (const node of plan.assignments)
      if (node.role !== 'main-synthesis' && !ancestors.has(node.id))
        errors.push(`Main synthesis must wait for settled assignment ${node.id}.`);
  }
  return errors;
}
export function validateDelegationPlan(
  plan: DelegationPlan,
  availability?: DelegationAvailability,
): DelegationValidation {
  const errors = graphErrors(plan);
  const integration = plan.assignments.find((node) => node.role === 'main-integration');
  const verification = plan.assignments.find((node) => node.role === 'runtime-verification');
  if (
    integration &&
    verification &&
    (verification.harness !== integration.harness ||
      verification.executable !== integration.executable ||
      verification.executableVersion !== integration.executableVersion)
  )
    errors.push(
      'Runtime verification must use the same native harness and executable as main integration.',
    );
  if (availability)
    for (const assignment of plan.assignments) {
      const route = availability.routes.find(
        (candidate) =>
          candidate.harness === assignment.harness &&
          candidate.executable === assignment.executable &&
          candidate.version === assignment.executableVersion,
      );
      if (!route || !route.enabled) {
        errors.push(`${assignment.id} uses an unavailable or disabled route.`);
        continue;
      }
      const model = route.models.find((candidate) => candidate.id === assignment.model);
      if (!model || !model.efforts.includes(assignment.effort))
        errors.push(`${assignment.id} uses an unavailable model or effort.`);
      if (!route.modes.includes(assignment.mode))
        errors.push(`${assignment.id} uses an unavailable execution mode.`);
      if (assignment.role === 'runtime-verification' && !route.commandCapability)
        errors.push(`${assignment.id} requires a verified native command capability.`);
    }
  if (availability?.mainSelection) {
    const selection = availability.mainSelection;
    const exact = (assignment: DelegationAssignment) =>
      assignment.harness === selection.harness &&
      assignment.executable === selection.executable &&
      assignment.executableVersion === selection.executableVersion &&
      assignment.model === selection.model &&
      assignment.effort === selection.effort;
    for (const assignment of plan.assignments.filter(
      (node) => node.role === 'main-integration' || node.role === 'main-synthesis',
    ))
      if (!exact(assignment))
        errors.push(`${assignment.id} must use the frozen selected main-agent identity.`);
  }
  return errors.length
    ? { valid: false, errors }
    : { valid: true, errors: [], digest: delegationPlanDigest(plan) };
}
