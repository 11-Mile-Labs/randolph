import type { HarnessAdapter, HarnessId } from './contracts.js';
import { assertDelegationBasis } from './delegation-basis.js';
import type { DelegationCommandPolicy } from './delegation-commands.js';
import type { DelegationAvailability } from './delegation-plan-types.js';
import type { DelegationSession } from './delegation-session-records.js';
import type { NativeAdmission } from './native-admission.js';
import { conversationHasBlockingRun } from './runtime-status.js';
import type { Store } from './store.js';

/**
 * Every behavioural dependency is a reader, never a value: the composition root
 * builds Pushes and Reviews after DelegationCommands, so a captured value would
 * be permanently undefined and a captured boolean would freeze at startup. The
 * store, the native admission gate and the adapter map pass by reference
 * because they are live objects already assigned when the policy is built.
 */
export type DelegationPolicyReaders = {
  store: Store;
  nativeAdmission: NativeAdmission;
  adapters: Partial<Record<HarnessId, HarnessAdapter>>;
  isAccepting: () => boolean;
  isAdmitting: (conversationId: string) => boolean;
  isRunActive: (runId: string) => boolean;
  reviewsBusy: (conversationId: string) => boolean;
  pushesBusy: (conversationId: string) => boolean;
  sessions: (runId: string) => DelegationSession[];
};

export function delegationCommandPolicy(readers: DelegationPolicyReaders): DelegationCommandPolicy {
  return {
    assertMutable: (run) => {
      if (
        !readers.isAccepting() ||
        readers.isAdmitting(run.conversationId) ||
        readers.isRunActive(run.id) ||
        readers.reviewsBusy(run.conversationId) ||
        readers.pushesBusy(run.conversationId)
      )
        throw new Error('Wait for current work to settle before changing this proposal.');
      const runs = readers.store
        .runs()
        .filter((candidate) => candidate.conversationId === run.conversationId);
      if (runs.at(-1)?.id !== run.id)
        throw new Error('A newer conversation request superseded this proposal.');
      if (
        conversationHasBlockingRun(runs, run.conversationId) ||
        readers
          .sessions(run.id)
          .some((session) =>
            ['prepared', 'dispatch-intent', 'running', 'cleanup-unconfirmed'].includes(
              session.state,
            ),
          )
      )
        throw new Error('Native work and cleanup must settle before a proposal decision.');
    },
    assertBasis: (run, plan) => assertDelegationBasis(readers.store, run, plan),
    availability: async (run, plan) => {
      const available: DelegationAvailability['routes'] = [];
      const unique = [
        ...new Map(
          plan.plan.assignments.map((assignment) => [
            `${assignment.harness}:${assignment.executable}`,
            assignment,
          ]),
        ).values(),
      ];
      const results = await Promise.allSettled(
        unique.map(async (assignment) => {
          if (
            !run.enabledHarnessRoutes?.some(
              (route) =>
                route.harness === assignment.harness && route.executable === assignment.executable,
            )
          )
            return;
          const found = readers.adapters[assignment.harness];
          if (!found) return;
          const info = await readers.nativeAdmission
            .adapter(assignment.harness, found, {
              owner: { kind: 'delegation', id: run.id },
              runId: run.id,
            })
            .discover(assignment.executable);
          if (
            !info.available ||
            !info.authenticated ||
            info.executable !== assignment.executable ||
            !info.version
          )
            return;
          available.push({
            harness: assignment.harness,
            executable: info.executable,
            version: info.version,
            models: info.models.map((model) => ({ id: model.id, efforts: model.efforts })),
            modes: info.executionModes ?? ['read-only'],
            enabled: true,
            commandCapability: Boolean(
              found.runCommand &&
              info.commandLifecycle === true &&
              info.executionModes?.includes('code'),
            ),
          });
        }),
      );
      if (results.some((result) => result.status === 'rejected'))
        throw new Error('A proposed CLI could not be inspected. Refresh before approval.');
      if (!run.executable || !run.executableVersion)
        throw new Error('The retained main-agent CLI identity is incomplete.');
      return {
        routes: available,
        mainSelection: {
          harness: run.harness ?? 'codex',
          executable: run.executable,
          executableVersion: run.executableVersion,
          model: run.model,
          effort: run.effort,
        },
      };
    },
  };
}
