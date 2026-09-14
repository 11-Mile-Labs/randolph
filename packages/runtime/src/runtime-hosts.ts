import type { RecoveryHost } from './checkpoint-recovery.js';
import type { DispatchHost } from './run-dispatch.js';
import type { ProjectSetupHost } from './project-setup-runtime.js';
import type { RuntimeBindings } from './runtime-bindings.js';

function shared(runtime: RuntimeBindings) {
  return {
    isAccepting: () => runtime.accepting,
    store: runtime.store,
    checkpoints: runtime.checkpoints,
    memory: runtime.memory,
    reviews: runtime.reviews,
    pushes: runtime.pushes,
    integrations: runtime.integrations,
    executionOrigin: runtime.executionOrigin,
    admission: runtime.admission,
    active: runtime.active,
    conversation: (id: string) => runtime.conversation(id),
    project: (id: string) => runtime.project(id),
    planWorkspace: (...args: Parameters<RuntimeBindings['planWorkspace']>) => runtime.planWorkspace(...args),
    execute: (...args: Parameters<RuntimeBindings['execute']>) => runtime.execute(...args),
    finish: (...args: Parameters<RuntimeBindings['finish']>) => runtime.finish(...args),
    changed: () => runtime.changed(),
  };
}

export function recoveryHost(runtime: RuntimeBindings): RecoveryHost {
  const core = shared(runtime);
  return {
    ...core,
    inspectExecutable: (harness, executable) => runtime.inspectExecutable(harness, executable),
    validateSelection: (selection, info) => runtime.validateSelection(selection, info),
    validateExecutionMode: (mode, info) => runtime.validateExecutionMode(mode, info),
    preparation: () => runtime.workspaces.preparation(),
    transferWorkspace: (plan, held) => runtime.workspaces.transfer(plan, held),
    releaseWorkspaces: (held, failure) => runtime.workspaces.release(held, failure),
    observeExecution: (run, work) => runtime.workspaces.observe(run, work),
  };
}

export function dispatchHost(runtime: RuntimeBindings): DispatchHost {
  const core = shared(runtime);
  return {
    ...core,
    workspaces: runtime.workspaces,
    ownership: runtime.workspaceOwnership,
    harness: runtime.routes,
  };
}

export function setupHost(runtime: RuntimeBindings): ProjectSetupHost {
  return {
    isAccepting: () => runtime.accepting,
    store: runtime.store,
    workspaces: runtime.workspaces,
    ownership: runtime.workspaceOwnership,
    delegation: runtime.delegation,
    nativeAdmission: runtime.nativeAdmission,
    executionOrigin: runtime.executionOrigin,
    admission: runtime.admission,
    setupAdmission: runtime.setupAdmission,
    active: runtime.active,
    project: id => runtime.project(id),
    createConversation: projectId => runtime.createConversation(projectId),
    send: (input, setup) => runtime.prepareSend(input, setup),
    changed: () => runtime.changed(),
  };
}
