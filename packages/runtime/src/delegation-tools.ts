import type { ApplicationTools, ApplicationToolResult } from './contracts.js';
import { DelegationRecords } from './delegation-records.js';
import {
  parseDelegationDraft,
  validateDelegationPlan,
  type DelegationAvailability,
} from './delegation-plan.js';

type Json = Record<string, unknown>;
const object = (value: unknown): value is Json =>
  Boolean(value) && typeof value === 'object' && !Array.isArray(value);
const jsonReceipt = (value: Json): ApplicationToolResult => ({
  success: true,
  text: JSON.stringify(value),
});
const receiptFits = (value: Json): boolean =>
  Buffer.byteLength(JSON.stringify(jsonReceipt(value))) <= 60 * 1024;
const string = { type: 'string', minLength: 1, maxLength: 4000 };
const assignmentSchema = {
  type: 'object',
  additionalProperties: false,
  required: [
    'id',
    'task',
    'role',
    'harness',
    'executable',
    'executableVersion',
    'model',
    'effort',
    'rationale',
    'dependencies',
    'source',
    'mode',
    'deliverables',
    'completionCriteria',
  ],
  properties: {
    id: { ...string, maxLength: 80, pattern: '^[a-z][a-z0-9-]*$' },
    task: string,
    role: {
      type: 'string',
      enum: ['worker', 'main-integration', 'runtime-verification', 'review', 'main-synthesis'],
    },
    harness: { type: 'string', enum: ['codex', 'grok'] },
    executable: string,
    executableVersion: string,
    model: string,
    effort: string,
    rationale: string,
    dependencies: { type: 'array', maxItems: 32, items: string },
    source: {
      type: 'string',
      description:
        'run-basis or output:<node-id>. Output sources must also be explicit dependencies.',
    },
    mode: { type: 'string', enum: ['read-only', 'code'] },
    deliverables: { type: 'array', minItems: 1, maxItems: 20, items: string },
    completionCriteria: { type: 'array', minItems: 1, maxItems: 20, items: string },
    producesSource: { type: 'boolean' },
    integrationInputs: { type: 'array', minItems: 1, maxItems: 16, items: string },
    repairAttempts: { type: 'integer', minimum: 0, maximum: 10 },
  },
};
export const delegationToolDefinitions: ApplicationTools['definitions'] = [
  {
    name: 'randolph_propose_delegation',
    description:
      'Record an editable delegation proposal for this run. This never starts workers or approves anything. Finish your turn after proposing so Randolph can freeze the source and ask for approval. Default to working alone unless workers provide a concrete benefit. Include the selected main agent for synthesis, and explicit integration then same-harness verification for code. Each Code writer must be an integration input; reviews inspect checked output. Read-only work needs no code integration or verification.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['plan'],
      properties: {
        plan: {
          type: 'object',
          additionalProperties: false,
          required: ['schemaVersion', 'id', 'revision', 'assignments', 'limits'],
          properties: {
            schemaVersion: { type: 'integer', const: 1 },
            id: { ...string, maxLength: 80 },
            revision: { type: 'integer', minimum: 1 },
            assignments: { type: 'array', minItems: 1, maxItems: 24, items: assignmentSchema },
            limits: {
              type: 'object',
              additionalProperties: false,
              required: ['maxWorkers', 'maxParallel', 'maxAttempts', 'activeMinutes'],
              properties: {
                maxWorkers: { type: 'integer', minimum: 1, maximum: 16 },
                maxParallel: { type: 'integer', minimum: 1, maximum: 16 },
                maxAttempts: { type: 'integer', minimum: 1, maximum: 10 },
                activeMinutes: { type: 'integer', minimum: 1, maximum: 480 },
              },
            },
          },
        },
      },
    },
  },
  {
    name: 'randolph_read_tasks',
    description:
      'Read bounded retained task states from this run. Optional taskIds selects known tasks. This cannot inspect unrelated runs, arbitrary filesystem paths, approve plans or launch workers.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        taskIds: {
          type: 'array',
          maxItems: 24,
          items: { type: 'string', minLength: 1, maxLength: 500 },
        },
      },
    },
  },
];

export function createDelegationTools(
  records: DelegationRecords,
  scope: {
    runId: string;
    sessionId: string;
    requestId: string;
    basis: Json;
    availability: DelegationAvailability;
  },
): ApplicationTools {
  const frozen = structuredClone(scope);
  if (!frozen.availability.mainSelection)
    throw new Error('Delegation tools require the frozen main selection.');
  return {
    definitions: structuredClone(delegationToolDefinitions),
    onRequest(request): ApplicationToolResult {
      const payload = request.arguments;
      if (!object(payload))
        return { success: false, text: 'Application tool arguments must be an object.' };
      const retained = records.recordToolReceipt(
        {
          runId: frozen.runId,
          sessionId: frozen.sessionId,
          threadId: request.threadId,
          turnId: request.turnId,
          callId: request.callId,
          requestId: request.requestId,
          tool: request.name,
          payload,
        },
        () => {
          if (request.name === 'randolph_propose_delegation') {
            if (Object.keys(payload).some((key) => key !== 'plan'))
              return {
                success: false,
                text: 'Only the plan field is permitted. The application supplies the run and session scope.',
              };
            let plan;
            try {
              plan = parseDelegationDraft(payload.plan);
            } catch (cause) {
              return {
                success: false,
                text:
                  cause instanceof Error
                    ? cause.message.slice(0, 1000)
                    : 'Invalid delegation plan.',
              };
            }
            const validation = validateDelegationPlan(plan, frozen.availability);
            const revision = (records.plans(frozen.runId).at(-1)?.revision ?? 0) + 1;
            const recorded = records.recordPlan({
              runId: frozen.runId,
              revision,
              requestId: frozen.requestId,
              source: 'proposal',
              basis: frozen.basis,
              plan,
            });
            const result = {
              planId: recorded.id,
              revision: recorded.revision,
              digest: recorded.digest,
              disposition: recorded.disposition,
              approvalReady: false,
              validationErrorCount: validation.errors.length,
              validationErrorsTruncated: false,
              validationErrors: [] as string[],
              message:
                'Draft retained. No workers started. Finish this native turn before the application can prepare approval.',
            };
            for (const error of validation.errors) {
              if (
                !receiptFits({ ...result, validationErrors: [...result.validationErrors, error] })
              )
                break;
              result.validationErrors.push(error);
            }
            result.validationErrorsTruncated =
              result.validationErrors.length !== validation.errors.length;
            return jsonReceipt(result);
          }
          if (request.name === 'randolph_read_tasks') {
            if (
              Object.keys(payload).some((key) => key !== 'taskIds') ||
              (payload.taskIds !== undefined &&
                (!Array.isArray(payload.taskIds) ||
                  payload.taskIds.length > 24 ||
                  payload.taskIds.some((id) => typeof id !== 'string' || !id || id.length > 500)))
            )
              return { success: false, text: 'Only a bounded taskIds selection is permitted.' };
            const tasks = records.tasks(frozen.runId);
            const selected = payload.taskIds as string[] | undefined;
            if (selected?.some((id) => !tasks.some((task) => task.id === id)))
              return { success: false, text: 'A requested task is not retained in this run.' };
            const matching = tasks.filter((task) => !selected || selected.includes(task.id));
            const summaries = [];
            for (const task of matching.slice(0, 24)) {
              const summary = {
                id: task.id,
                assignmentId: task.assignmentId,
                state: task.state,
                dependencies: task.dependencies,
                attempts: task.attempts.map((attempt) => ({
                  id: attempt.id,
                  generation: attempt.generation,
                  status: attempt.status,
                  error: attempt.error?.slice(0, 1000),
                })),
              };
              if (
                !receiptFits({
                  total: matching.length,
                  truncated: true,
                  tasks: [...summaries, summary],
                })
              )
                break;
              summaries.push(summary);
            }
            return jsonReceipt({
              total: matching.length,
              truncated: matching.length > summaries.length,
              tasks: summaries,
            });
          }
          return { success: false, text: 'Unknown application tool.' };
        },
      );
      const response = retained.receipt.receipt;
      if (typeof response.success !== 'boolean' || typeof response.text !== 'string')
        throw new Error('Retained application tool receipt is invalid.');
      return { success: response.success, text: response.text };
    },
  };
}
