import type { HarnessAdapter, HarnessId } from './contracts.js';
import type { NativeAdmissionCleanup, NativeAdmissionContext } from './native-admission-types.js';
import type { NativeOperation } from './native-operation-records.js';

/**
 * The admission owner's `perform` entry point, handed in already bound. The wrapper holds no
 * admission state of its own: no active/waiting/legacy maps, no queue mutation, no store writes.
 */
export type NativePerformer = <T>(
  harness: HarnessId,
  context: NativeAdmissionContext,
  purpose: NativeOperation['purpose'],
  executable: string | undefined,
  signal: AbortSignal | undefined,
  invoke: (signal: AbortSignal) => Promise<T>,
  cleanup: (result: T) => NativeAdmissionCleanup,
) => Promise<T>;

/** Wraps one raw adapter so every native probe and run passes through admission. */
export function admittedHarnessAdapter(
  harness: HarnessId,
  context: NativeAdmissionContext,
  adapter: HarnessAdapter,
  perform: NativePerformer,
): HarnessAdapter {
  return {
    // Inventory is filesystem-only. Every native probe must use discover.
    ...(adapter.installations ? { installations: () => adapter.installations!() } : {}),
    discover: (executable, signal) =>
      perform(
        harness,
        context,
        'discovery',
        executable,
        signal,
        async (ownedSignal) => {
          const info = await adapter.discover(executable, ownedSignal);
          return info.cleanupVerified === true
            ? info
            : {
                ...info,
                available: false,
                authenticated: false,
                models: [],
                executionModes: [],
                reason: 'Native discovery cleanup could not be confirmed.',
              };
        },
        (info) => ({
          status: info.available ? 'completed' : 'failed',
          confirmed: info.cleanupVerified === true,
          evidence: { adapterCleanupVerified: info.cleanupVerified === true },
          ...(info.executable && info.version
            ? { identity: { executable: info.executable, version: info.version } }
            : {}),
        }),
      ),
    run: async (value) => {
      const input = {
        ...value,
        messages: structuredClone(value.messages),
        workspaceIdentity: value.workspaceIdentity
          ? structuredClone(value.workspaceIdentity)
          : undefined,
        ...(value.applicationTools
          ? {
              applicationTools: {
                definitions: structuredClone(value.applicationTools.definitions),
                onRequest: value.applicationTools.onRequest,
              },
            }
          : {}),
      };
      let accepting = true;
      try {
        return await perform(
          harness,
          context,
          'model-turn',
          input.executable,
          input.signal,
          (signal) =>
            adapter.run({
              ...input,
              signal,
              onEvent: (event) => {
                if (accepting) input.onEvent(event);
              },
              ...(input.applicationTools
                ? {
                    applicationTools: {
                      ...input.applicationTools,
                      onRequest: (request) => {
                        if (!accepting || signal.aborted)
                          throw new Error(
                            'Native application tool request arrived after cancellation or settlement.',
                          );
                        return input.applicationTools!.onRequest(request);
                      },
                    },
                  }
                : {}),
            }),
          (result) => ({
            status: result.status === 'stop-unconfirmed' ? 'failed' : result.status,
            confirmed: result.status !== 'stop-unconfirmed',
            evidence: { adapterStatus: result.status },
          }),
        );
      } finally {
        accepting = false;
      }
    },
    ...(adapter.runCommand
      ? {
          runCommand: async (value: Parameters<NonNullable<HarnessAdapter['runCommand']>>[0]) => {
            const input = {
              ...value,
              command: [...value.command],
              workspaceIdentity: value.workspaceIdentity
                ? structuredClone(value.workspaceIdentity)
                : undefined,
            };
            let accepting = true;
            try {
              return await perform(
                harness,
                context,
                'command',
                input.executable,
                input.signal,
                (signal) =>
                  adapter.runCommand!({
                    ...input,
                    signal,
                    onDispatch: (value) => {
                      if (!accepting || signal.aborted)
                        throw new Error(
                          'Native command dispatch arrived after cancellation or settlement.',
                        );
                      const checked: unknown = input.onDispatch?.(value);
                      if (checked && typeof (checked as { then?: unknown }).then === 'function') {
                        void (async () => {
                          try {
                            await checked;
                          } catch {
                            /* Rejected asynchronous dispatch callbacks remain unauthorized. */
                          }
                        })();
                        throw new Error('Native command dispatch callbacks must be synchronous.');
                      }
                    },
                    onOutput: (value) => {
                      if (accepting) input.onOutput(value);
                    },
                  }),
                (result) => ({
                  status: result.exitCode === 0 ? 'completed' : 'failed',
                  confirmed: result.cleanupVerified === true,
                  evidence: {
                    adapterCleanupVerified: result.cleanupVerified === true,
                    exitCode: result.exitCode,
                  },
                }),
              );
            } finally {
              accepting = false;
            }
          },
        }
      : {}),
  };
}
